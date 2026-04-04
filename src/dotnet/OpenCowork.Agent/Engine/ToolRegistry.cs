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
    public Func<string, IReadOnlyList<object?>?, CancellationToken, Task<JsonElement?>>? ElectronInvokeAsync { get; init; }
    public Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<JsonElement?>>? RendererToolInvokeAsync { get; init; }
    public Func<string, Dictionary<string, JsonElement>, ToolContext, CancellationToken, Task<bool>>? RendererToolRequiresApprovalAsync { get; init; }
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

        if (handler is null) return true;
        return handler.RequiresApproval?.Invoke(input, ctx) ?? false;
    }
}
