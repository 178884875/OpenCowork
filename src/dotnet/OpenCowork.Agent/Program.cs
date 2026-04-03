using OpenCowork.Agent.Protocol;
using OpenCowork.Agent.Benchmark;

namespace OpenCowork.Agent;

public static class Program
{
    public const string Version = "0.1.0";

    public static async Task<int> Main(string[] args)
    {
        // Redirect stderr for logging (stdout is reserved for JSON-RPC)
        var logWriter = Console.Error;

        if (args.Length > 0 && string.Equals(args[0], "benchmark", StringComparison.OrdinalIgnoreCase))
        {
            return await BenchmarkRunner.RunAsync(Console.Out);
        }

        Log(logWriter, $"OpenCowork Agent v{Version} starting...");

        await using var transport = new StdioJsonRpcTransport();
        var router = new MessageRouter(transport);

        // Wire a CTS for graceful shutdown on SIGTERM / SIGINT / stdin close
        using var processCts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            processCts.Cancel();
        };

        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            processCts.Cancel();
        };

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
            processCts.Token,
            router.ShutdownToken);

        Log(logWriter, "Ready. Listening for JSON-RPC messages on stdin.");

        try
        {
            await router.RunAsync(linkedCts.Token);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown
        }
        catch (Exception ex)
        {
            Log(logWriter, $"Fatal error: {ex}");
            return 1;
        }

        Log(logWriter, "Shutting down.");
        return 0;
    }

    private static void Log(TextWriter writer, string message)
    {
        writer.WriteLine($"[{DateTime.UtcNow:HH:mm:ss.fff}] {message}");
        writer.Flush();
    }
}
