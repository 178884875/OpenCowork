using System.Runtime.CompilerServices;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

/// <summary>
/// A provider that delegates each streaming request back to the renderer
/// process via an IPC bridge. Used when the sidecar doesn't have a native
/// implementation for the requested provider type, so the agent loop itself
/// stays in .NET while provider HTTP traffic runs in the renderer's existing
/// JS provider modules.
/// </summary>
public sealed class BridgedProvider : ILlmProvider
{
    private readonly Func<ProviderConfig, List<UnifiedMessage>, List<ToolDefinition>, CancellationToken, IAsyncEnumerable<StreamEvent>> _invoke;

    public string Name => "Bridged Provider";
    public string Type => "bridged";

    public BridgedProvider(
        Func<ProviderConfig, List<UnifiedMessage>, List<ToolDefinition>, CancellationToken, IAsyncEnumerable<StreamEvent>> invoke)
    {
        _invoke = invoke;
    }

    public async IAsyncEnumerable<StreamEvent> SendMessageAsync(
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        ProviderConfig config,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        await foreach (var ev in _invoke(config, messages, tools, ct).WithCancellation(ct))
        {
            yield return ev;
        }
    }
}
