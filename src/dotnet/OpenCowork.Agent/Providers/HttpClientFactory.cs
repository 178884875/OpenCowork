using System.Net;

namespace OpenCowork.Agent.Providers;

/// <summary>
/// Singleton pooled HttpClient per provider configuration.
/// Uses SocketsHttpHandler for connection pooling and proxy support.
/// </summary>
public sealed class LlmHttpClientFactory : IDisposable
{
    private readonly Dictionary<string, HttpClient> _clients = new();
    private readonly object _lock = new();

    public HttpClient GetClient(string? proxyUrl = null)
    {
        var key = proxyUrl ?? "__default__";

        lock (_lock)
        {
            if (_clients.TryGetValue(key, out var existing))
                return existing;

            var handler = new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(10),
                PooledConnectionIdleTimeout = TimeSpan.FromMinutes(5),
                MaxConnectionsPerServer = 10,
                EnableMultipleHttp2Connections = true,
            };

            if (proxyUrl is not null)
            {
                handler.Proxy = new WebProxy(proxyUrl);
                handler.UseProxy = true;
            }

            var client = new HttpClient(handler)
            {
                Timeout = Timeout.InfiniteTimeSpan
            };

            _clients[key] = client;
            return client;
        }
    }

    public void Dispose()
    {
        foreach (var client in _clients.Values)
            client.Dispose();
        _clients.Clear();
    }
}
