using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Providers;
using OpenCowork.Agent.SubAgents;
using OpenCowork.Agent.Tools.Fs;

namespace OpenCowork.Agent.Protocol;

public sealed class AgentRuntimeService
{
    private readonly StdioJsonRpcTransport _transport;
    private readonly Func<string, object?, CancellationToken, TimeSpan?, Task<JsonElement?>> _sendRequestAsync;
    private readonly LlmHttpClientFactory _httpClientFactory = new();
    private readonly ToolRegistry _toolRegistry = new();
    private readonly SubAgentRunner _subAgentRunner;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeRuns = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _readFileHistory = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, Channel<StreamEvent>> _bridgedProviderStreams = new();

    private static readonly string[] SupportedCapabilities =
    [
        "agent.run",
        "agent.cancel",
        "streaming",
        "tools",
        "tool.Read",
        "tool.Write",
        "tool.Edit",
        "tool.Bash",
        "tool.Delete",
        "tool.Move",
        "tool.LS",
        "tool.Glob",
        "tool.Grep",
        "fs.grep",
        "tool.DesktopScreenshot",
        "tool.DesktopClick",
        "tool.DesktopType",
        "tool.DesktopScroll",
        "tool.DesktopWait",
        "tool.TaskCreate",
        "tool.TaskGet",
        "tool.TaskUpdate",
        "tool.TaskList",
        "tool.AskUserQuestion",
        "tool.EnterPlanMode",
        "tool.SavePlan",
        "tool.ExitPlanMode",
        "tool.visualize_show_widget",
        "tool.Notify",
        "tool.CronAdd",
        "tool.CronUpdate",
        "tool.CronRemove",
        "tool.CronList",
        "tool.Task",
        "tool.Skill",
        "tool.ImageGenerate",
        "desktop.input",
        "provider.anthropic",
        "provider.openai-chat",
        "provider.openai-responses",
        "provider.gemini"
    ];

    public AgentRuntimeService(
        StdioJsonRpcTransport transport,
        Func<string, object?, CancellationToken, TimeSpan?, Task<JsonElement?>> sendRequestAsync)
    {
        _transport = transport;
        _sendRequestAsync = sendRequestAsync;
        _subAgentRunner = new SubAgentRunner(_toolRegistry);
        RegisterBuiltinTools();
    }

    public IReadOnlyList<string> GetCapabilities() => SupportedCapabilities;

    public bool SupportsCapability(string capability) =>
        SupportedCapabilities.Contains(capability, StringComparer.OrdinalIgnoreCase);

    public async Task<AgentRunResult> StartRunAsync(AgentRunParams input, CancellationToken ct)
    {
        var runId = string.IsNullOrWhiteSpace(input.RunId)
            ? Guid.NewGuid().ToString("N")
            : input.RunId!;
        var runCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (!_activeRuns.TryAdd(runId, runCts))
            throw new InvalidOperationException("Failed to register run");

        Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] StartRunAsync accepted runId={runId} provider={input.Provider.Type} tools={input.Tools.Count}");

        _ = Task.Run(async () =>
        {
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] background task started runId={runId}");
            try
            {
                var provider = CreateProvider(input.Provider, runId);
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] provider created runId={runId} provider={input.Provider.Type}");

                var toolContext = new ToolContext
                {
                    SessionId = input.SessionId ?? runId,
                    WorkingFolder = input.WorkingFolder ?? Environment.CurrentDirectory,
                    CurrentToolUseId = null,
                    AgentRunId = runId,
                    PluginId = input.PluginId,
                    PluginChatId = input.PluginChatId,
                    PluginChatType = input.PluginChatType,
                    PluginSenderId = input.PluginSenderId,
                    PluginSenderName = input.PluginSenderName,
                    SshConnectionId = input.SshConnectionId,
                    ProviderConfig = input.Provider,
                    ElectronInvokeAsync = CreateElectronInvokeHandler(runCts.Token),
                    RendererToolInvokeAsync = CreateRendererToolInvokeHandler(runId, runCts.Token),
                    RendererToolRequiresApprovalAsync = CreateRendererToolRequiresApprovalHandler(runId, runCts.Token),
                    EmitAgentEventAsync = (evt, token) => SendAgentEventAsync(runId, evt, token),
                    ReadFileHistory = _readFileHistory
                };

                var isChatMode = string.Equals(input.SessionMode, "chat", StringComparison.OrdinalIgnoreCase);
                var loopConfig = new AgentLoopRunConfig
                {
                    Provider = provider,
                    ProviderConfig = input.Provider,
                    Tools = input.Tools,
                    ToolRegistry = _toolRegistry,
                    ToolContext = toolContext,
                    // Chat mode collapses to a single assistant turn regardless
                    // of the requested maxIterations.
                    MaxIterations = isChatMode ? 1 : input.MaxIterations,
                    ForceApproval = input.ForceApproval,
                    Compression = input.Compression,
                    EnableParallelToolExecution = true,
                    SessionMode = input.SessionMode,
                    PlanMode = input.PlanMode,
                    PlanModeAllowedTools = input.PlanModeAllowedTools is { Count: > 0 }
                        ? new HashSet<string>(input.PlanModeAllowedTools, StringComparer.Ordinal)
                        : null
                };

                var approvalHandler = CreateApprovalHandler(runId, toolContext.SessionId, runCts.Token);
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] entering agent loop runId={runId}");

                await foreach (var evt in AgentLoop.RunAsync(input.Messages, loopConfig, approvalHandler, runCts.Token))
                {
                    Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event produced runId={runId} type={evt.Type}");
                    await SendAgentEventAsync(runId, evt, runCts.Token);
                }

                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] agent loop completed runId={runId}");
            }
            catch (OperationCanceledException)
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] run cancelled runId={runId}");
                await SendAgentEventAsync(runId, new LoopEndEvent { Reason = "aborted" }, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] run failed runId={runId}: {ex}");
                await SendAgentEventAsync(runId, new AgentErrorEvent
                {
                    Message = BuildErrorMessage(ex),
                    ErrorType = ex.GetType().Name,
                    Details = BuildErrorDetails(ex),
                    StackTrace = ex.StackTrace
                }, CancellationToken.None);
                await SendAgentEventAsync(runId, new LoopEndEvent { Reason = "error" }, CancellationToken.None);
            }
            finally
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] cleaning up runId={runId}");
                if (_activeRuns.TryRemove(runId, out var linkedCts))
                    linkedCts.Dispose();
                // Return heap memory to OS after run completes
                GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                GC.WaitForPendingFinalizers();
            }
        }, CancellationToken.None);

        return new AgentRunResult { Started = true, RunId = runId };
    }

    public Task<AgentCancelResult> CancelRunAsync(AgentCancelParams input)
    {
        var cancelled = _activeRuns.TryRemove(input.RunId, out var cts);
        if (cancelled)
        {
            cts!.Cancel();
            cts.Dispose();
        }

        return Task.FromResult(new AgentCancelResult
        {
            Cancelled = cancelled,
            RunId = input.RunId
        });
    }

    private void RegisterBuiltinTools()
    {
        RegisterRendererBridgedTool("Read", "Read a file from the filesystem", ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"offset":{"type":"number","description":"Start line (1-indexed)"},"limit":{"type":"number","description":"Number of lines to read"}},"required":["file_path"]}"""));

        RegisterRendererBridgedTool("Write", "Write a file to the filesystem", ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "file_path": { "type": "string", "description": "Absolute path or relative to the working folder" },
                    "content": { "type": "string", "description": "The content to write to the file" }
                  },
                  "required": ["file_path", "content"]
                }
                """));

        RegisterRendererBridgedTool("Edit", "Perform exact string replacements in files", ParseSchema("""{"type":"object","properties":{"file_path":{"type":"string","description":"Absolute path or relative to the working folder"},"old_string":{"type":"string","description":"The text to replace"},"new_string":{"type":"string","description":"The text to replace it with"},"replace_all":{"type":"boolean","description":"Replace all occurrences of old_string"}},"required":["file_path","old_string","new_string"]}"""));

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Bash",
                Description = "Execute a shell command",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "command": { "type": "string", "description": "The command to execute" },
                    "timeout": { "type": "number", "description": "Timeout in milliseconds" },
                    "description": { "type": "string", "description": "Short description of the command" }
                  },
                  "required": ["command"]
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var command = GetString(input, "command", required: true);
                var timeoutMs = Math.Clamp(GetOptionalInt(input, "timeout") ?? 600000, 1, 3600000);
                var result = await AgentRuntimeService.ExecuteShellCommandAsync(command, ctx.WorkingFolder, timeoutMs, token);
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["stdout"] = JsonValue.Create(result.Stdout),
                        ["stderr"] = JsonValue.Create(result.Stderr),
                        ["exitCode"] = JsonValue.Create(result.ExitCode)
                    }),
                    IsError = result.ExitCode != 0
                };
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Delete",
                Description = "Delete a file or directory",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "path": { "type": "string", "description": "Absolute path or relative to the working folder" }
                  },
                  "required": ["path"]
                }
                """)
            },
            Execute = (input, ctx, _) =>
            {
                var path = ResolvePath(GetString(input, "path", required: true), ctx.WorkingFolder);
                FsOperations.Delete(path);
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["success"] = JsonValue.Create(true),
                        ["path"] = JsonValue.Create(path)
                    })
                });
            },
            RequiresApproval = (input, ctx) => !IsWithinWorkingFolder(ResolvePath(GetString(input, "path", required: true), ctx.WorkingFolder), ctx.WorkingFolder)
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Move",
                Description = "Move or rename a file or directory",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "source": { "type": "string", "description": "Source path" },
                    "destination": { "type": "string", "description": "Destination path" }
                  },
                  "required": ["source", "destination"]
                }
                """)
            },
            Execute = (input, ctx, _) =>
            {
                var source = ResolvePath(GetString(input, "source", required: true), ctx.WorkingFolder);
                var destination = ResolvePath(GetString(input, "destination", required: true), ctx.WorkingFolder);
                FsOperations.Move(source, destination);
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["success"] = JsonValue.Create(true),
                        ["source"] = JsonValue.Create(source),
                        ["destination"] = JsonValue.Create(destination)
                    })
                });
            },
            RequiresApproval = (input, ctx) =>
                !IsWithinWorkingFolder(ResolvePath(GetString(input, "source", required: true), ctx.WorkingFolder), ctx.WorkingFolder) ||
                !IsWithinWorkingFolder(ResolvePath(GetString(input, "destination", required: true), ctx.WorkingFolder), ctx.WorkingFolder)
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "LS",
                Description = "List files and directories in a given path",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "path": { "type": "string", "description": "Absolute path or relative to the working folder" },
                    "ignore": {
                      "type": "array",
                      "items": { "type": "string" },
                      "description": "Optional file or directory names to ignore"
                    }
                  },
                  "required": []
                }
                """)
            },
            Execute = (input, ctx, _) =>
            {
                var path = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var ignore = GetOptionalStringArray(input, "ignore");
                var entries = FsOperations.ListDirectory(path, ignore: ignore)
                    .Select(entry => new
                    {
                        name = entry.Name,
                        type = entry.Type,
                        path = Path.Combine(path, entry.Name)
                    })
                    .ToList();
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonArray(entries.Select(entry => (JsonNode)BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["name"] = JsonValue.Create(entry.name),
                        ["type"] = JsonValue.Create(entry.type),
                        ["path"] = JsonValue.Create(entry.path)
                    })))
                });
            },
            RequiresApproval = (_, _) => false
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Glob",
                Description = "Fast file pattern matching tool",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern to match files" },
                    "path": { "type": "string", "description": "Optional search directory" }
                  },
                  "required": ["pattern"]
                }
                """)
            },
            Execute = (input, ctx, _) =>
            {
                var directory = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var pattern = GetString(input, "pattern", required: true);
                var results = GlobTool.Search(directory, pattern);
                return Task.FromResult(new ToolResultContent
                {
                    Content = BuildJsonArray(results.Select(static item => JsonValue.Create(item)))
                });
            },
            RequiresApproval = (_, _) => false
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Grep",
                Description = "Search file contents using regular expressions",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "pattern": { "type": "string", "description": "Regex pattern to search for" },
                    "path": { "type": "string", "description": "Directory to search in" },
                    "include": { "type": "string", "description": "File pattern filter, e.g. *.ts" }
                  },
                  "required": ["pattern"]
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var directory = ResolvePath(GetOptionalString(input, "path") ?? ".", ctx.WorkingFolder);
                var pattern = GetString(input, "pattern", required: true);
                var include = GetOptionalString(input, "include");
                var result = await GrepTool.SearchAsync(directory, pattern, new GrepOptions
                {
                    GlobPattern = include,
                    MaxResults = 200
                }, token);
                var lines = result.Matches.Select(match => $"{match.File}:{match.Line}:{match.Content}").ToList();
                return new ToolResultContent
                {
                    Content = BuildJsonArray(lines.Select(static item => JsonValue.Create(item)))
                };
            },
            RequiresApproval = (_, _) => false
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopScreenshot",
                Description = "Capture a full desktop screenshot and return it to the agent.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "delayMs": { "type": "number", "description": "Optional delay in milliseconds before capturing the screenshot." }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var delayMs = GetOptionalInt(input, "delayMs") ?? 0;
                if (delayMs > 0)
                    await Task.Delay(Math.Min(delayMs, 5000), token);

                var result = await InvokeElectronAsync(ctx, "desktop:screenshot:capture", [], token);
                var success = GetBoolean(result, "success");
                if (!success)
                {
                    return new ToolResultContent
                    {
                        Content = new JsonObject
                        {
                            ["error"] = GetString(result, "error") ?? "Failed to capture desktop screenshot."
                        }.ToJsonString(),
                        IsError = true
                    };
                }

                var data = GetString(result, "data");
                if (string.IsNullOrWhiteSpace(data))
                {
                    return new ToolResultContent
                    {
                        Content = new JsonObject
                        {
                            ["error"] = "Failed to capture desktop screenshot."
                        }.ToJsonString(),
                        IsError = true
                    };
                }

                return new ToolResultContent
                {
                    Content = new ContentBlock[]
                    {
                        new ImageBlock
                        {
                            Source = new ImageSource
                            {
                                Type = "base64",
                                MediaType = GetString(result, "mediaType") ?? "image/png",
                                Data = data
                            }
                        },
                        new TextBlock
                        {
                            Text = $"Captured desktop screenshot {GetString(result, "width") ?? "?"}x{GetString(result, "height") ?? "?"} across {GetString(result, "displayCount") ?? "1"} display(s)."
                        }
                    }
                };
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopClick",
                Description = "Move the cursor to a desktop coordinate and perform a mouse action.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "button": { "type": "string", "enum": ["left", "right", "middle"] },
                    "action": { "type": "string", "enum": ["click", "double_click", "down", "up"] }
                  },
                  "required": ["x", "y"],
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var payload = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["x"] = JsonValue.Create(GetOptionalDouble(input, "x") ?? throw new InvalidOperationException("Missing required field: x")),
                    ["y"] = JsonValue.Create(GetOptionalDouble(input, "y") ?? throw new InvalidOperationException("Missing required field: y")),
                    ["button"] = JsonValue.Create(GetOptionalString(input, "button") ?? "left"),
                    ["action"] = JsonValue.Create(GetOptionalString(input, "action") ?? "click")
                });
                var result = await InvokeElectronAsync(ctx, "desktop:input:click", [payload], token);
                return CreateDesktopInputResult(result);
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopType",
                Description = "Type text, press a key, or send a hotkey on the desktop.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "text": { "type": "string" },
                    "key": { "type": "string" },
                    "hotkey": { "type": "array", "items": { "type": "string" } }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var payload = new JsonObject();
                if (input.TryGetValue("text", out var text) && text.ValueKind == JsonValueKind.String)
                    payload["text"] = text.GetString();
                if (input.TryGetValue("key", out var key) && key.ValueKind == JsonValueKind.String)
                    payload["key"] = key.GetString();
                if (input.TryGetValue("hotkey", out var hotkey) && hotkey.ValueKind == JsonValueKind.Array)
                {
                    var hotkeyArray = new JsonArray();
                    foreach (var item in hotkey.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String)
                            hotkeyArray.Add(item.GetString());
                    }
                    payload["hotkey"] = hotkeyArray;
                }
                var result = await InvokeElectronAsync(ctx, "desktop:input:type", [payload], token);
                return CreateDesktopInputResult(result);
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopScroll",
                Description = "Scroll the desktop, optionally after moving to an anchor point.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "scrollX": { "type": "number" },
                    "scrollY": { "type": "number" }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, ctx, token) =>
            {
                var payload = new JsonObject();
                if (GetOptionalDouble(input, "x") is { } x) payload["x"] = x;
                if (GetOptionalDouble(input, "y") is { } y) payload["y"] = y;
                if (GetOptionalDouble(input, "scrollX") is { } scrollX) payload["scrollX"] = scrollX;
                if (GetOptionalDouble(input, "scrollY") is { } scrollY) payload["scrollY"] = scrollY;
                var result = await InvokeElectronAsync(ctx, "desktop:input:scroll", [payload], token);
                return CreateDesktopInputResult(result);
            },
            RequiresApproval = (_, _) => true
        });

        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "DesktopWait",
                Description = "Wait briefly before the next desktop action.",
                InputSchema = ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "durationMs": { "type": "number" }
                  },
                  "additionalProperties": false
                }
                """)
            },
            Execute = async (input, _, token) =>
            {
                var durationMs = GetOptionalInt(input, "durationMs") ?? 0;
                await Task.Delay(Math.Clamp(durationMs, 0, 10000), token);
                return new ToolResultContent
                {
                    Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                    {
                        ["success"] = JsonValue.Create(true),
                        ["durationMs"] = JsonValue.Create(Math.Clamp(durationMs, 0, 10000))
                    })
                };
            },
            RequiresApproval = (_, _) => true
        });

        // NOTE: Stage 1 — the top-level agent loop now auto-bridges unknown
        // tools to the renderer via ToolRegistry.Execute's dynamic fallback,
        // so newly added JS-only tools (MCP, plugins, WebFetch, etc.) no
        // longer require a sidecar update. The static registrations below
        // are still used by SubAgentRunner (SubAgents/SubAgentRunner.cs:422
        // reads _toolRegistry.GetDefinitions() to resolve sub-agent tool
        // allowlists) and must stay until sub-agent tool resolution is
        // refactored to use the parent request's Tools list (Stage 6).
        RegisterRendererBridgedTool("TaskCreate", "Create a task for the current session.", ParseSchema("""{"type":"object","properties":{"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"metadata":{"type":"object"}},"required":["subject","description"]}"""));
        RegisterRendererBridgedTool("TaskGet", "Retrieve a task by its ID.", ParseSchema("""{"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}"""));
        RegisterRendererBridgedTool("TaskUpdate", "Update a task.", ParseSchema("""{"type":"object","properties":{"taskId":{"type":"string"},"subject":{"type":"string"},"description":{"type":"string"},"activeForm":{"type":"string"},"status":{"type":"string"},"addBlocks":{"type":"array","items":{"type":"string"}},"addBlockedBy":{"type":"array","items":{"type":"string"}},"owner":{"type":"string"},"metadata":{"type":"object"}},"required":["taskId"]}"""));
        RegisterRendererBridgedTool("TaskList", "List all tasks in the current session.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("AskUserQuestion", "Ask the user questions during execution.", ParseSchema("""{"type":"object","properties":{"questions":{"type":"array"},"metadata":{"type":"object"}},"required":["questions"]}"""));
        RegisterRendererBridgedTool("EnterPlanMode", "Enter plan mode.", ParseSchema("""{"type":"object","properties":{"reason":{"type":"string"}}}"""));
        RegisterRendererBridgedTool("SavePlan", "Save the current plan content.", ParseSchema("""{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"}},"required":["content"]}"""));
        RegisterRendererBridgedTool("ExitPlanMode", "Exit plan mode.", ParseSchema("""{"type":"object","properties":{}}"""));
        RegisterRendererBridgedTool("visualize_show_widget", "Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — that renders inline alongside your text response.\nUse for flowcharts, architecture diagrams, dashboards, forms, calculators, data tables, games, illustrations, or any visual content.\nThe code is auto-detected: starts with <svg = SVG mode, otherwise HTML mode.\nA global sendPrompt(text) function is available — it sends a message to chat as if the user typed it.\nIMPORTANT: Call read_me before your first show_widget call.", ParseSchema("""
                {
                  "type": "object",
                  "properties": {
                    "title": {
                      "type": "string",
                      "description": "Short snake_case identifier for this visual. Must be specific and disambiguating."
                    },
                    "loading_messages": {
                      "type": "array",
                      "description": "1-4 loading messages shown to the user while the visual renders.",
                      "minItems": 1,
                      "maxItems": 4,
                      "items": { "type": "string" }
                    },
                    "widget_code": {
                      "type": "string",
                      "description": "SVG or HTML code to render. For SVG: raw SVG code starting with <svg> tag. For HTML: raw HTML content without DOCTYPE, <html>, <head>, or <body> tags."
                    }
                  },
                  "required": ["loading_messages", "title", "widget_code"]
                }
                """));
        RegisterRendererBridgedTool("Notify", "Send a desktop notification to the user.", ParseSchema("""{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"type":{"type":"string"},"duration":{"type":"number"}},"required":["title","body"]}"""));
        RegisterRendererBridgedTool("CronAdd", "Create a scheduled cron job.", ParseSchema("""{"type":"object","properties":{"name":{"type":"string"},"schedule":{"type":"object"},"prompt":{"type":"string"}},"required":["name","schedule","prompt"]}"""));
        RegisterRendererBridgedTool("CronUpdate", "Update an existing cron job.", ParseSchema("""{"type":"object","properties":{"jobId":{"type":"string"},"patch":{"type":"object"}},"required":["jobId","patch"]}"""));
        RegisterRendererBridgedTool("CronRemove", "Remove a scheduled cron job.", ParseSchema("""{"type":"object","properties":{"jobId":{"type":"string"}},"required":["jobId"]}"""));
        RegisterRendererBridgedTool("CronList", "List scheduled cron jobs.", ParseSchema("""{"type":"object","properties":{}}"""));
        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = "Task",
                Description = "Run a sub-agent task.",
                InputSchema = ParseSchema("""{"type":"object","properties":{"subagent_type":{"type":"string"},"description":{"type":"string"},"prompt":{"type":"string"},"model":{"type":"string"},"resume":{"type":"string"},"readonly":{"type":"boolean"},"attachments":{"type":"array","items":{"type":"string"}},"run_in_background":{"type":"boolean"}},"required":["subagent_type","description","prompt"]}""")
            },
            Execute = ExecuteTaskToolAsync,
            RequiresApproval = (input, _) => GetOptionalBool(input, "run_in_background") == true
        });
        RegisterRendererBridgedTool("Skill", "Load a skill by name.", ParseSchema("""{"type":"object","properties":{"SkillName":{"type":"string"}},"required":["SkillName"]}"""));
        RegisterRendererBridgedTool("ImageGenerate", "Generate images from a complete visual prompt.", ParseSchema("""{"type":"object","properties":{"prompt":{"type":"string"},"count":{"type":"number"}},"required":["prompt"]}"""));
    }

    private void RegisterRendererBridgedTool(string name, string description, JsonElement inputSchema)
    {
        _toolRegistry.Register(new ToolHandler
        {
            Definition = new ToolDefinition
            {
                Name = name,
                Description = description,
                InputSchema = inputSchema
            },
            Execute = (input, ctx, token) => InvokeRendererToolAsync(ctx, name, input, token),
            RequiresApproval = (_, _) => false
        });
    }

    private static JsonElement ParseSchema(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static JsonObject BuildJsonObject(IEnumerable<KeyValuePair<string, JsonNode?>> properties)
    {
        var obj = new JsonObject();
        foreach (var property in properties)
        {
            obj[property.Key] = property.Value;
        }
        return obj;
    }

    private static JsonArray BuildJsonArray(IEnumerable<JsonNode?> items)
    {
        var array = new JsonArray();
        foreach (var item in items)
        {
            array.Add(item);
        }
        return array;
    }

    private static string GetString(Dictionary<string, JsonElement> input, string key, bool required = false)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            if (required) throw new InvalidOperationException($"Missing required field: {key}");
            return string.Empty;
        }

        var text = value.GetString();
        if (required && string.IsNullOrWhiteSpace(text))
            throw new InvalidOperationException($"Missing required field: {key}");
        return text ?? string.Empty;
    }

    private static string GetFilePath(Dictionary<string, JsonElement> input, bool required = false)
    {
        var filePath = GetOptionalString(input, "file_path");
        if (!string.IsNullOrWhiteSpace(filePath))
            return filePath;

        if (required)
            throw new InvalidOperationException("Missing required field: file_path");

        return string.Empty;
    }

    private static string? GetOptionalString(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.GetString();
    }

    private static int? GetOptionalInt(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;
    }

    private static bool? GetOptionalBool(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static double? GetOptionalDouble(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;
    }

    private static string[]? GetOptionalStringArray(Dictionary<string, JsonElement> input, string key)
    {
        if (!input.TryGetValue(key, out var value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        if (value.ValueKind != JsonValueKind.Array)
            return null;

        return value.EnumerateArray()
            .Where(static item => item.ValueKind == JsonValueKind.String)
            .Select(static item => item.GetString())
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .ToArray();
    }

    private static string ResolvePath(string rawPath, string workingFolder)
    {
        if (Path.IsPathRooted(rawPath))
            return Path.GetFullPath(rawPath);
        return Path.GetFullPath(Path.Combine(string.IsNullOrWhiteSpace(workingFolder) ? Environment.CurrentDirectory : workingFolder, rawPath));
    }

    private static string BuildEditNotFoundMessage(string content, string oldString)
    {
        return "old_string not found in file";
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)> ExecuteShellCommandAsync(
        string command,
        string? workingFolder,
        int timeoutMs,
        CancellationToken ct)
    {
        var isWindows = OperatingSystem.IsWindows();
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = isWindows ? "cmd.exe" : "/bin/sh",
            Arguments = isWindows ? $"/c {command}" : $"-lc \"{command.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)}\"",
            WorkingDirectory = string.IsNullOrWhiteSpace(workingFolder) ? Environment.CurrentDirectory : workingFolder,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = new System.Diagnostics.Process { StartInfo = startInfo };
        process.Start();

        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var waitTask = process.WaitForExitAsync(timeoutCts.Token);
        var delayTask = Task.Delay(timeoutMs, timeoutCts.Token);
        var completedTask = await Task.WhenAny(waitTask, delayTask);

        if (completedTask == delayTask)
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
            }

            throw new TimeoutException($"Command timed out after {timeoutMs}ms");
        }

        timeoutCts.Cancel();
        await waitTask;
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        return (process.ExitCode, stdout, stderr);
    }

    private static bool IsWithinWorkingFolder(string path, string workingFolder)
    {
        if (string.IsNullOrWhiteSpace(workingFolder)) return false;
        var root = Path.GetFullPath(workingFolder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(path);
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || string.Equals(full, root, StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildErrorMessage(Exception ex)
    {
        var message = string.IsNullOrWhiteSpace(ex.Message) ? ex.GetType().Name : ex.Message.Trim();
        var innerMessages = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var current = ex.InnerException;

        while (current is not null && innerMessages.Count < 3)
        {
            var currentMessage = string.IsNullOrWhiteSpace(current.Message)
                ? current.GetType().Name
                : current.Message.Trim();

            if (!string.Equals(currentMessage, message, StringComparison.Ordinal) && seen.Add(currentMessage))
                innerMessages.Add($"{current.GetType().Name}: {currentMessage}");

            current = current.InnerException;
        }

        return innerMessages.Count == 0
            ? message
            : $"{message} | {string.Join(" | ", innerMessages)}";
    }

    private static string? BuildErrorDetails(Exception ex)
    {
        var lines = new List<string>();
        var current = ex;
        var depth = 0;

        while (current is not null && depth < 5)
        {
            var message = string.IsNullOrWhiteSpace(current.Message)
                ? current.GetType().Name
                : current.Message.Trim();
            var label = depth == 0 ? "Error" : $"Inner[{depth}]";
            lines.Add($"{label}: {current.GetType().Name}: {message}");
            current = current.InnerException;
            depth++;
        }

        return lines.Count > 1 ? string.Join(Environment.NewLine, lines) : null;
    }

    private async Task SendAgentEventAsync(string runId, AgentEvent evt, CancellationToken ct)
    {
        try
        {
            await _transport.SendNotificationAsync("agent/event", new AgentEventNotification
            {
                RunId = runId,
                Event = SerializeAgentEvent(evt)
            }, ct);
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event sent runId={runId} type={evt.Type}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss.fff}] [AgentRuntime] event send failed runId={runId} type={evt.Type}: {ex}");
            throw;
        }
    }

    private static JsonElement SerializeAgentEvent(AgentEvent evt)
    {
        var node = JsonSerializer.SerializeToNode(evt, AppJsonContext.Default.AgentEvent)?.AsObject()
            ?? throw new InvalidOperationException($"Failed to serialize agent event {evt.GetType().Name}");

        if (!node.ContainsKey("type"))
            node["type"] = evt.Type;

        using var doc = JsonDocument.Parse(node.ToJsonString());
        return doc.RootElement.Clone();
    }

    private ApprovalHandler CreateApprovalHandler(string runId, string sessionId, CancellationToken ct)
    {
        return async toolCall =>
        {
            var response = await _sendRequestAsync("approval/request", new ApprovalRequestParams
            {
                RunId = runId,
                SessionId = sessionId,
                ToolCall = toolCall
            }, ct, TimeSpan.FromMinutes(10));

            if (response is null)
                return false;

            var parsed = JsonSerializer.Deserialize(response.Value, AppJsonContext.Default.ApprovalResponseResult);
            return parsed?.Approved == true;
        };
    }

    private async Task<ToolResultContent> ExecuteTaskToolAsync(
        Dictionary<string, JsonElement> input,
        ToolContext ctx,
        CancellationToken ct)
    {
        if (GetOptionalBool(input, "run_in_background") == true)
        {
            return await InvokeRendererToolAsync(ctx, "Task", input, ct);
        }

        var subAgentName = GetString(input, "subagent_type", required: true);
        var definition = await GetSubAgentDefinitionAsync(ctx, subAgentName, ct);
        if (definition is null)
        {
            return new ToolResultContent
            {
                Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["error"] = JsonValue.Create($"Unknown subagent_type \"{subAgentName}\".")
                })
            };
        }

        if (ctx.ProviderConfig is null)
            throw new InvalidOperationException("Provider config is unavailable for sub-agent execution.");

        var provider = CreateProvider(ctx.ProviderConfig, ctx.AgentRunId ?? ctx.SessionId);
        var result = await _subAgentRunner.RunAsync(definition, input, provider, ctx.ProviderConfig, ctx, CreateApprovalHandler(ctx.AgentRunId ?? ctx.SessionId, ctx.SessionId, ct), ct);

        if (!result.Result.Success)
        {
            return new ToolResultContent
            {
                Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["error"] = JsonValue.Create(result.Result.Error ?? "Sub-agent failed"),
                    ["result"] = string.IsNullOrWhiteSpace(result.Result.Output)
                        ? null
                        : JsonValue.Create(result.Result.Output)
                })
            };
        }

        return new ToolResultContent
        {
            Content = result.Result.Output
        };
    }

    private async Task<SubAgentDefinition?> GetSubAgentDefinitionAsync(
        ToolContext ctx,
        string name,
        CancellationToken ct)
    {
        if (_subAgentRunner.Get(name) is { } cached)
            return cached;

        var response = await InvokeElectronAsync(ctx, "agents:list", Array.Empty<object?>(), ct);
        if (response.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var item in response.EnumerateArray())
        {
            var definition = ParseSubAgentDefinition(item);
            if (definition is null)
                continue;
            _subAgentRunner.Register(definition);
        }

        return _subAgentRunner.Get(name);
    }

    private static SubAgentDefinition? ParseSubAgentDefinition(JsonElement element)
    {
        if (!element.TryGetProperty("name", out var nameValue) || nameValue.ValueKind != JsonValueKind.String)
            return null;
        if (!element.TryGetProperty("systemPrompt", out var systemPromptValue) || systemPromptValue.ValueKind != JsonValueKind.String)
            return null;

        var tools = GetOptionalStringArray(element, "tools")
            ?? GetOptionalStringArray(element, "allowedTools")
            ?? new[] { "Read", "Glob", "Grep", "LS", "Bash" };
        var maxTurns = GetOptionalInt(element, "maxTurns") ?? GetOptionalInt(element, "maxIterations") ?? 0;

        return new SubAgentDefinition
        {
            Name = nameValue.GetString()!,
            Description = GetString(element, "description"),
            SystemPrompt = systemPromptValue.GetString(),
            Tools = tools.ToList(),
            DisallowedTools = (GetOptionalStringArray(element, "disallowedTools") ?? Array.Empty<string>()).ToList(),
            MaxTurns = maxTurns,
            InitialPrompt = GetString(element, "initialPrompt"),
            Model = GetString(element, "model"),
            Temperature = GetOptionalDouble(element, "temperature")
        };
    }

    private Func<string, IReadOnlyList<object?>?, CancellationToken, Task<JsonElement?>> CreateElectronInvokeHandler(CancellationToken runCt)
    {
        return async (channel, args, token) =>
        {
            var linked = CancellationTokenSource.CreateLinkedTokenSource(runCt, token);
            var payload = new ElectronInvokeParams
            {
                Channel = channel,
                Args = args?.Select(ArgToJsonElement).ToList()
            };
            var response = await _sendRequestAsync("electron/invoke", payload, linked.Token, TimeSpan.FromMinutes(2));
            return response;
        };
    }

    /// <summary>
    /// Convert an arbitrary invoke argument to a JsonElement without going through
    /// reflection-based serialization (disabled in this app). JsonNode/JsonElement
    /// pass through directly; primitives use their registered JsonTypeInfo; unknown
    /// types are rendered as strings.
    /// </summary>
    private static JsonElement ArgToJsonElement(object? arg)
    {
        switch (arg)
        {
            case null:
                return JsonSerializer.SerializeToElement<string?>(null, AppJsonContext.Default.String);
            case JsonElement element:
                return element.Clone();
            case JsonNode node:
            {
                using var doc = JsonDocument.Parse(node.ToJsonString());
                return doc.RootElement.Clone();
            }
            case string text:
                return JsonSerializer.SerializeToElement(text, AppJsonContext.Default.String);
            case bool boolean:
                return JsonSerializer.SerializeToElement(boolean, AppJsonContext.Default.Boolean);
            case int int32:
                return JsonSerializer.SerializeToElement(int32, AppJsonContext.Default.Int32);
            case long int64:
                return JsonSerializer.SerializeToElement(int64, AppJsonContext.Default.Int64);
            case double float64:
                return JsonSerializer.SerializeToElement(float64, AppJsonContext.Default.Double);
            case Dictionary<string, JsonElement> dict:
                return JsonSerializer.SerializeToElement(dict, AppJsonContext.Default.DictionaryStringJsonElement);
            case Dictionary<string, object?> dictObj:
                return JsonSerializer.SerializeToElement(dictObj, AppJsonContext.Default.DictionaryStringObject);
            default:
                return JsonSerializer.SerializeToElement(
                    arg.ToString() ?? string.Empty,
                    AppJsonContext.Default.String);
        }
    }

    private Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<JsonElement?>> CreateRendererToolInvokeHandler(string runId, CancellationToken runCt)
    {
        return async (toolName, input, ctx, token) =>
        {
            var linked = CancellationTokenSource.CreateLinkedTokenSource(runCt, token);
            var payload = new RendererToolRequestParams
            {
                ToolName = toolName,
                Input = input,
                SessionId = ctx.SessionId,
                WorkingFolder = ctx.WorkingFolder,
                CurrentToolUseId = ctx.CurrentToolUseId,
                AgentRunId = ctx.AgentRunId ?? runId,
                PluginId = ctx.PluginId,
                PluginChatId = ctx.PluginChatId,
                PluginChatType = ctx.PluginChatType,
                PluginSenderId = ctx.PluginSenderId,
                PluginSenderName = ctx.PluginSenderName,
                SshConnectionId = ctx.SshConnectionId
            };
            return await _sendRequestAsync("renderer/tool-request", payload, linked.Token, TimeSpan.FromMinutes(10));
        };
    }

    private Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<bool>> CreateRendererToolRequiresApprovalHandler(string runId, CancellationToken runCt)
    {
        return async (toolName, input, ctx, token) =>
        {
            var response = await CreateRendererToolInvokeHandler(runId, runCt)(toolName + "#requiresApproval", input, ctx, token);
            if (response is null)
                return true;

            if (response.Value.ValueKind == JsonValueKind.True)
                return true;
            if (response.Value.ValueKind == JsonValueKind.False)
                return false;
            if (response.Value.ValueKind == JsonValueKind.Object && response.Value.TryGetProperty("requiresApproval", out var requiresApproval))
                return requiresApproval.ValueKind == JsonValueKind.True;

            return true;
        };
    }

    private static async Task<JsonElement> InvokeElectronAsync(ToolContext ctx, string channel, IReadOnlyList<object?> args, CancellationToken ct)
    {
        if (ctx.ElectronInvokeAsync is null)
            throw new InvalidOperationException("Electron invoke bridge is unavailable.");

        var response = await ctx.ElectronInvokeAsync(channel, args, ct);
        if (response is null)
            throw new InvalidOperationException($"Electron invoke returned no result for {channel}.");

        return response.Value;
    }

    private static async Task<ToolResultContent> InvokeRendererToolAsync(ToolContext ctx, string toolName, Dictionary<string, JsonElement> input, CancellationToken ct)
    {
        if (ctx.RendererToolInvokeAsync is null)
            throw new InvalidOperationException("Renderer tool bridge is unavailable.");

        var response = await ctx.RendererToolInvokeAsync(toolName, input, ctx, ct);
        if (response is null)
            throw new InvalidOperationException($"Renderer tool invoke returned no result for {toolName}.");

        var parsed = JsonSerializer.Deserialize(response.Value, AppJsonContext.Default.RendererToolResponseResult);
        if (parsed is null)
            throw new InvalidOperationException($"Renderer tool invoke returned invalid result for {toolName}.");

        return new ToolResultContent
        {
            Content = parsed.Content?.Clone() ?? JsonSerializer.SerializeToElement(string.Empty, AppJsonContext.Default.JsonElement),
            IsError = parsed.IsError || !string.IsNullOrWhiteSpace(parsed.Error)
        };
    }

    private static ToolResultContent CreateDesktopInputResult(JsonElement result)
    {
        if (!GetBoolean(result, "success"))
        {
            return new ToolResultContent
            {
                Content = BuildJsonObject(new Dictionary<string, JsonNode?>
                {
                    ["error"] = JsonValue.Create(GetString(result, "error") ?? "Desktop operation failed.")
                }),
                IsError = true
            };
        }

        return new ToolResultContent
        {
            Content = JsonNode.Parse(result.GetRawText()) ?? JsonValue.Create(string.Empty)
        };
    }

    private static bool GetBoolean(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return false;
        return value.ValueKind == JsonValueKind.True || (value.ValueKind == JsonValueKind.False ? false : value.GetBoolean());
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return null;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };
    }

    private static int? GetOptionalInt(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;
    }

    private static double? GetOptionalDouble(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
            return null;
        return value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;
    }

    private static string[]? GetOptionalStringArray(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.Array)
            return null;

        return value.EnumerateArray()
            .Where(static item => item.ValueKind == JsonValueKind.String)
            .Select(static item => item.GetString())
            .Where(static item => !string.IsNullOrWhiteSpace(item))
            .Cast<string>()
            .ToArray();
    }

    private ILlmProvider CreateProvider(ProviderConfig config, string runId)
    {
        if (string.Equals(config.Mode, "bridged", StringComparison.OrdinalIgnoreCase))
            return new BridgedProvider(CreateBridgedProviderInvoker(runId));

        return config.Type switch
        {
            "anthropic" => new AnthropicProvider(_httpClientFactory),
            "openai-chat" => new OpenAiChatProvider(_httpClientFactory),
            "openai-responses" => new OpenAiResponsesProvider(_httpClientFactory),
            "gemini" => new GeminiProvider(_httpClientFactory),
            _ => new BridgedProvider(CreateBridgedProviderInvoker(runId))
        };
    }

    private Func<ProviderConfig, List<UnifiedMessage>, List<ToolDefinition>, CancellationToken, IAsyncEnumerable<StreamEvent>>
        CreateBridgedProviderInvoker(string runId)
    {
        return (config, messages, tools, ct) => InvokeBridgedProviderAsync(runId, config, messages, tools, ct);
    }

    private async IAsyncEnumerable<StreamEvent> InvokeBridgedProviderAsync(
        string runId,
        ProviderConfig config,
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var streamId = Guid.NewGuid().ToString("N");
        var channel = Channel.CreateBounded<StreamEvent>(new BoundedChannelOptions(256)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });

        _bridgedProviderStreams[streamId] = channel;

        var startParams = new BridgedProviderStreamStartParams
        {
            StreamId = streamId,
            ProviderType = config.Type,
            ProviderConfig = config,
            Messages = messages,
            Tools = tools,
            AgentRunId = runId
        };

        var startTask = _sendRequestAsync(
            "renderer/provider-stream-start",
            startParams,
            ct,
            TimeSpan.FromMinutes(10));

        // When the renderer's response comes back (or errors), signal channel completion
        // in case the renderer missed sending a Done event.
        _ = startTask.ContinueWith(t =>
        {
            if (t.IsFaulted)
            {
                var inner = t.Exception?.GetBaseException();
                channel.Writer.TryComplete(inner);
            }
            else
            {
                channel.Writer.TryComplete();
            }
        }, TaskScheduler.Default);

        try
        {
            await foreach (var ev in channel.Reader.ReadAllAsync(ct))
            {
                yield return ev;
            }
        }
        finally
        {
            _bridgedProviderStreams.TryRemove(streamId, out _);
            try { await startTask.ConfigureAwait(false); } catch { /* already surfaced via channel or ct */ }
        }
    }

    /// <summary>
    /// Called by MessageRouter when a "provider/stream-event" notification arrives.
    /// Routes the event to the waiting bridged provider's channel by streamId.
    /// </summary>
    public Task HandleBridgedProviderStreamEventAsync(JsonElement? @params, CancellationToken ct)
    {
        if (!@params.HasValue)
            return Task.CompletedTask;

        var parsed = JsonSerializer.Deserialize(@params.Value, AppJsonContext.Default.BridgedProviderStreamEventParams);
        if (parsed is null || string.IsNullOrWhiteSpace(parsed.StreamId))
            return Task.CompletedTask;

        if (!_bridgedProviderStreams.TryGetValue(parsed.StreamId, out var channel))
            return Task.CompletedTask;

        if (parsed.Done)
        {
            if (!string.IsNullOrWhiteSpace(parsed.Error))
                channel.Writer.TryComplete(new InvalidOperationException(parsed.Error));
            else
                channel.Writer.TryComplete();
            return Task.CompletedTask;
        }

        if (parsed.Event is not null)
        {
            // Use TryWrite to avoid blocking the message pump; bounded channel will
            // drop-then-wait only under extreme backpressure, which we don't expect
            // for SSE-rate events.
            if (!channel.Writer.TryWrite(parsed.Event))
            {
                return channel.Writer.WriteAsync(parsed.Event, ct).AsTask();
            }
        }

        return Task.CompletedTask;
    }
}
