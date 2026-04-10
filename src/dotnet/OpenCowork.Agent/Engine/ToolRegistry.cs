using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenCowork.Agent.Engine;

public delegate Task<ToolResultContent> ToolExecuteDelegate(
    Dictionary<string, JsonElement> input,
    ToolContext context,
    CancellationToken ct);

public delegate bool RequiresApprovalDelegate(
    Dictionary<string, JsonElement> input,
    ToolContext context);

public class ToolHandler
{
    public required ToolDefinition Definition { get; init; }
    public required ToolExecuteDelegate Execute { get; init; }
    public RequiresApprovalDelegate? RequiresApproval { get; init; }
}

public class ToolContext
{
    public required string SessionId { get; init; }
    public required string WorkingFolder { get; init; }
    public string? CurrentToolUseId { get; init; }
    public string? AgentRunId { get; init; }
    public string? PluginId { get; init; }
    public string? PluginChatId { get; init; }
    public string? PluginChatType { get; init; }
    public string? PluginSenderId { get; init; }
    public string? PluginSenderName { get; init; }
    public string? SshConnectionId { get; init; }
    public ProviderConfig? ProviderConfig { get; init; }
    public Func<string, IReadOnlyList<object?>?, CancellationToken, Task<JsonElement?>>? ElectronInvokeAsync { get; init; }
    public Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<JsonElement?>>? RendererToolInvokeAsync { get; init; }
    public Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<bool>>? RendererToolRequiresApprovalAsync { get; init; }
    public Func<AgentEvent, CancellationToken, Task>? EmitAgentEventAsync { get; init; }
    public Dictionary<string, ToolHandler>? InlineToolHandlers { get; init; }
    public Dictionary<string, ToolHandler>? LocalToolHandlers { get; init; }
    public ConcurrentDictionary<string, DateTimeOffset>? ReadFileHistory { get; init; }
}

public class ToolResultContent
{
    public object Content { get; init; } = string.Empty;
    public bool IsError { get; init; }

    public string AsText()
    {
        return Content switch
        {
            null => string.Empty,
            string text => text,
            JsonNode node => node.ToJsonString(),
            JsonElement element => element.GetRawText(),
            IEnumerable<ContentBlock> blocks => string.Concat(blocks.Select(block => block switch
            {
                TextBlock textBlock => textBlock.Text,
                ImageBlock imageBlock => imageBlock.Source.FilePath ?? imageBlock.Source.Url ?? imageBlock.Source.Data ?? "[image]",
                _ => string.Empty
            })),
            _ => Content.ToString() ?? string.Empty
        };
    }
}

public sealed class ToolRegistry
{
    private readonly Dictionary<string, ToolHandler> _handlers = new();
    private List<ToolDefinition>? _cachedDefinitions;

    public void Register(ToolHandler handler)
    {
        _handlers[handler.Definition.Name] = handler;
        _cachedDefinitions = null;
    }

    public ToolHandler? Get(string name) =>
        _handlers.GetValueOrDefault(name);

    public List<ToolDefinition> GetDefinitions()
    {
        _cachedDefinitions ??= _handlers.Values
            .Select(h => h.Definition)
            .ToList();
        return _cachedDefinitions;
    }

    public async Task<ToolResultContent> Execute(string name,
        Dictionary<string, JsonElement> input, ToolContext ctx, CancellationToken ct)
    {
        // Check inline handlers first
        if (ctx.InlineToolHandlers?.TryGetValue(name, out var inlineHandler) == true)
            return await inlineHandler.Execute(input, ctx, ct);

        // Then local handlers
        if (ctx.LocalToolHandlers?.TryGetValue(name, out var localHandler) == true)
            return await localHandler.Execute(input, ctx, ct);

        // Then global registry
        if (_handlers.TryGetValue(name, out var handler))
            return await handler.Execute(input, ctx, ct);

        // Dynamic renderer-tool bridge: delegate unknown tools to the renderer
        // so newly added JS tools (MCP, plugins, WebFetch, etc.) don't require
        // a sidecar update. The renderer's tool registry is the source of truth.
        if (ctx.RendererToolInvokeAsync is not null)
            return await InvokeRendererToolFallbackAsync(name, input, ctx, ct);

        return new ToolResultContent
        {
            Content = $"Unknown tool: {name}",
            IsError = true
        };
    }

    public bool CheckRequiresApproval(string name,
        Dictionary<string, JsonElement> input, ToolContext ctx)
    {
        var handler = ctx.InlineToolHandlers?.GetValueOrDefault(name)
            ?? ctx.LocalToolHandlers?.GetValueOrDefault(name)
            ?? _handlers.GetValueOrDefault(name);

        // Dynamically bridged tool: the renderer-side probe
        // (RendererToolRequiresApprovalAsync) is the source of truth. Returning
        // false here ensures we don't double-gate and force approval on every
        // dynamically bridged call.
        if (handler is null)
            return ctx.RendererToolRequiresApprovalAsync is null;
        return handler.RequiresApproval?.Invoke(input, ctx) ?? false;
    }

    private static async Task<ToolResultContent> InvokeRendererToolFallbackAsync(
        string toolName,
        Dictionary<string, JsonElement> input,
        ToolContext ctx,
        CancellationToken ct)
    {
        var response = await ctx.RendererToolInvokeAsync!(toolName, input, ctx, ct);
        if (response is null)
        {
            return new ToolResultContent
            {
                Content = $"Renderer bridge returned no result for tool: {toolName}",
                IsError = true
            };
        }

        var parsed = JsonSerializer.Deserialize(response.Value, AppJsonContext.Default.RendererToolResponseResult);
        if (parsed is null)
        {
            return new ToolResultContent
            {
                Content = $"Renderer bridge returned invalid result for tool: {toolName}",
                IsError = true
            };
        }

        object content = parsed.Content?.Clone()
            ?? JsonSerializer.SerializeToElement(string.Empty, AppJsonContext.Default.String);

        return new ToolResultContent
        {
            Content = content,
            IsError = parsed.IsError || !string.IsNullOrWhiteSpace(parsed.Error)
        };
    }
}
