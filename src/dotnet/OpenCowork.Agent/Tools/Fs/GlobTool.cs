using Microsoft.Extensions.FileSystemGlobbing;
using Microsoft.Extensions.FileSystemGlobbing.Abstractions;

namespace OpenCowork.Agent.Tools.Fs;

/// <summary>
/// File glob using Microsoft.Extensions.FileSystemGlobbing (AOT-compatible).
/// </summary>
public static class GlobTool
{
    private static readonly HashSet<string> IgnoredDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", "dist", "out", "bin", "obj",
        ".next", ".nuxt", "__pycache__", ".venv", "coverage",
        ".cursor", ".idea", ".vs"
    };

    public static List<string> Search(string directory, string pattern, int maxResults = 1000)
    {
        var matcher = new Matcher();

        if (!pattern.StartsWith("**/") && !pattern.StartsWith("/"))
        {
            matcher.AddInclude("**/" + pattern);
        }
        else
        {
            matcher.AddInclude(pattern);
        }

        var dirInfo = new DirectoryInfo(directory);
        if (!dirInfo.Exists) return [];

        var result = matcher.Execute(new DirectoryInfoWrapper(dirInfo));

        return result.Files
            .Select(f => f.Path)
            .Where(f => !ShouldIgnore(f))
            .Take(maxResults)
            .Select(f => Path.Combine(directory, f))
            .ToList();
    }

    private static bool ShouldIgnore(string relativePath)
    {
        var parts = relativePath.Split('/', '\\');
        foreach (var part in parts)
        {
            if (IgnoredDirs.Contains(part))
                return true;
        }
        return false;
    }
}
