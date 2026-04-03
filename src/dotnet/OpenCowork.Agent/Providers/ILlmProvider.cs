namespace OpenCowork.Agent.Providers;

/// <summary>
/// Interface for LLM API providers.
/// Returns an IAsyncEnumerable of StreamEvent (mirrors TypeScript's AsyncIterable pattern).
/// </summary>
public interface ILlmProvider
{
    string Name { get; }
    string Type { get; }

    IAsyncEnumerable<StreamEvent> SendMessageAsync(
        List<Engine.UnifiedMessage> messages,
        List<Engine.ToolDefinition> tools,
        Engine.ProviderConfig config,
        CancellationToken ct = default);
}
