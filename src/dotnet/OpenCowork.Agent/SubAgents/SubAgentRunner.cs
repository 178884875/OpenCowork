using System.Text;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Providers;

namespace OpenCowork.Agent.SubAgents;

/// <summary>
/// Sub-agent runner with concurrency limiting via SemaphoreSlim.
/// </summary>
public sealed class SubAgentRunner
{
    private static readonly SemaphoreSlim SubAgentLimiter = new(2, 2);

    private readonly ToolRegistry _toolRegistry;
    private readonly Dictionary<string, SubAgentDefinition> _definitions = new();

    public SubAgentRunner(ToolRegistry toolRegistry)
    {
        _toolRegistry = toolRegistry;
    }

    public void Register(SubAgentDefinition definition)
    {
        _definitions[definition.Name] = definition;
    }

    public SubAgentDefinition? Get(string name) =>
        _definitions.GetValueOrDefault(name);

    public IReadOnlyList<SubAgentDefinition> GetAll() =>
        _definitions.Values.ToList();

    /// <summary>
    /// Run a sub-agent with concurrency limiting.
    /// Collects and returns the text output.
    /// </summary>
    public async Task<string> RunAsync(
        string agentName,
        string userMessage,
        ILlmProvider provider,
        ProviderConfig baseConfig,
        ToolContext toolContext,
        ApprovalHandler? onApproval = null,
        CancellationToken ct = default)
    {
        var definition = _definitions.GetValueOrDefault(agentName)
            ?? throw new ArgumentException($"Unknown sub-agent: {agentName}");

        await SubAgentLimiter.WaitAsync(ct);
        try
        {
            return await RunInternalAsync(
                definition, userMessage, provider, baseConfig, toolContext, onApproval, ct);
        }
        finally
        {
            SubAgentLimiter.Release();
        }
    }

    private async Task<string> RunInternalAsync(
        SubAgentDefinition definition,
        string userMessage,
        ILlmProvider provider,
        ProviderConfig baseConfig,
        ToolContext toolContext,
        ApprovalHandler? onApproval,
        CancellationToken ct)
    {
        var tools = ResolveTools(definition);

        var config = new ProviderConfig
        {
            Type = baseConfig.Type,
            ApiKey = baseConfig.ApiKey,
            BaseUrl = baseConfig.BaseUrl,
            Model = definition.Model ?? baseConfig.Model,
            MaxTokens = baseConfig.MaxTokens,
            Temperature = definition.Temperature ?? baseConfig.Temperature,
            SystemPrompt = definition.SystemPrompt ?? baseConfig.SystemPrompt
        };

        var initialMessages = new List<UnifiedMessage>();
        if (definition.SystemPrompt is not null)
        {
            initialMessages.Add(new UnifiedMessage
            {
                Role = "system",
                Content = new List<ContentBlock> { new TextBlock { Text = definition.SystemPrompt } }
            });
        }
        initialMessages.Add(new UnifiedMessage
        {
            Role = "user",
            Content = new List<ContentBlock> { new TextBlock { Text = userMessage } }
        });

        var runConfig = new AgentLoopRunConfig
        {
            Provider = provider,
            ProviderConfig = config,
            Tools = tools,
            ToolRegistry = _toolRegistry,
            ToolContext = toolContext,
            MaxIterations = definition.MaxTurns,
            EnableParallelToolExecution = true
        };

        var output = new StringBuilder();

        await foreach (var evt in AgentLoop.RunAsync(
            initialMessages, runConfig, onApproval, ct))
        {
            if (evt is TextDeltaEvent textEvt)
                output.Append(textEvt.Text);
        }

        return output.ToString();
    }

    private List<ToolDefinition> ResolveTools(SubAgentDefinition definition)
    {
        var allTools = _toolRegistry.GetDefinitions();

        if (definition.Tools is null || definition.Tools.Count == 0)
            return allTools;

        if (definition.Tools.Count == 1 && definition.Tools[0] == "*")
        {
            if (definition.DisallowedTools is { Count: > 0 })
            {
                var disallowed = new HashSet<string>(definition.DisallowedTools);
                return allTools.Where(t => !disallowed.Contains(t.Name)).ToList();
            }
            return allTools;
        }

        var allowedNames = new HashSet<string>(definition.Tools);
        var resolved = allTools.Where(t => allowedNames.Contains(t.Name)).ToList();

        if (definition.DisallowedTools is { Count: > 0 })
        {
            var disallowed = new HashSet<string>(definition.DisallowedTools);
            resolved = resolved.Where(t => !disallowed.Contains(t.Name)).ToList();
        }

        return resolved;
    }
}
