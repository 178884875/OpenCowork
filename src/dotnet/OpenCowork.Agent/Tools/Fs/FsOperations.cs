using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.FileSystemGlobbing;

namespace OpenCowork.Agent.Tools.Fs;

/// <summary>
/// Core filesystem operations: read, write, list, mkdir, delete, move.
/// </summary>
public static class FsOperations
{
    public const int MaxReadLines = 2000;

    // ── Encoding detection ──

    /// <summary>
    /// Detects the text encoding of a file by inspecting its BOM.
    /// Returns "utf16le", "utf8bom", or "utf8".
    /// </summary>
    public static string DetectFileEncoding(ReadOnlySpan<byte> head)
    {
        if (head.Length >= 2 && head[0] == 0xFF && head[1] == 0xFE) return "utf16le";
        if (head.Length >= 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF) return "utf8bom";
        return "utf8";
    }

    /// <summary>
    /// Reads raw file content with encoding detection.
    /// Returns the decoded string (BOM stripped) and the detected encoding tag.
    /// </summary>
    public static (string Content, string Encoding) ReadFileRawWithEncoding(string path)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        var bytes = File.ReadAllBytes(path);
        var enc = DetectFileEncoding(bytes);
        var content = enc switch
        {
            "utf16le" => Encoding.Unicode.GetString(bytes.AsSpan(2)),    // skip 2-byte BOM
            "utf8bom" => Encoding.UTF8.GetString(bytes.AsSpan(3)),       // skip 3-byte BOM
            _         => Encoding.UTF8.GetString(bytes)
        };
        return (content, enc);
    }

    public static async Task<string> ReadFileAsync(string path, int? offset = null,
        int? limit = null, CancellationToken ct = default)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        // Byte-level read so we can detect utf16le BOM correctly.
        // File.ReadAllTextAsync(path) defaults to UTF-8 and silently garbles utf16le files.
        var bytes = await File.ReadAllBytesAsync(path, ct);
        var enc = DetectFileEncoding(bytes);
        var rawContent = enc switch
        {
            "utf16le" => Encoding.Unicode.GetString(bytes.AsSpan(2)),
            "utf8bom" => Encoding.UTF8.GetString(bytes.AsSpan(3)),
            _         => Encoding.UTF8.GetString(bytes)
        };
        return FormatReadOutput(rawContent, offset, limit);
    }

    public static string FormatReadOutput(string content, int? offset = null, int? limit = null)
    {
        var normalized = content.Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n');
        var start = Math.Max(0, (offset ?? 1) - 1);
        var maxCount = limit ?? MaxReadLines;
        var count = Math.Max(0, Math.Min(maxCount, MaxReadLines));

        if (start >= lines.Length)
            return string.Empty;

        var end = Math.Min(start + count, lines.Length);
        var width = Math.Max(6, end.ToString().Length);
        var sb = new StringBuilder();
        for (var i = start; i < end; i++)
        {
            sb.Append((i + 1).ToString().PadLeft(width))
              .Append('\t')
              .Append(lines[i]);
            if (i < end - 1)
                sb.Append('\n');
        }
        return sb.ToString();
    }

    public static string ReadFileRaw(string path) => ReadFileRawWithEncoding(path).Content;
    public static void RecordRead(string path, IDictionary<string, DateTimeOffset>? readHistory)
    {
        if (readHistory is null) return;
        readHistory[Path.GetFullPath(path)] = DateTimeOffset.UtcNow;
    }

    public static string ReplaceExact(string content, string oldString, string newString, bool replaceAll)
    {
        if (string.IsNullOrEmpty(oldString))
            throw new InvalidOperationException("old_string must be non-empty");

        var occurrences = CountOccurrences(content, oldString);
        if (occurrences == 0)
            throw new InvalidOperationException("old_string not found in file");

        if (!replaceAll && occurrences > 1)
            throw new InvalidOperationException("old_string is not unique in file");

        return replaceAll
            ? content.Replace(oldString, newString, StringComparison.Ordinal)
            : ReplaceFirst(content, oldString, newString);
    }

    public static IReadOnlyList<(string Text, string Eol)> BuildOldStringVariants(string oldString, string fileContent)
    {
        var variants = new List<(string Text, string Eol)>
        {
            (oldString, DetectEolStyle(oldString))
        };

        var fileHasCrlf = fileContent.Contains("\r\n", StringComparison.Ordinal);
        var fileHasOnlyLf = !fileHasCrlf;

        if (oldString.Contains('\n') && !oldString.Contains('\r') && fileHasCrlf)
        {
            variants.Add((oldString.Replace("\n", "\r\n", StringComparison.Ordinal), "\r\n"));
        }
        else if (oldString.Contains("\r\n", StringComparison.Ordinal) && fileHasOnlyLf)
        {
            variants.Add((oldString.Replace("\r\n", "\n", StringComparison.Ordinal), "\n"));
        }

        return variants;
    }

    public static int CountOccurrences(string content, string value)
    {
        if (string.IsNullOrEmpty(value)) return 0;

        var count = 0;
        var index = 0;
        while (true)
        {
            index = content.IndexOf(value, index, StringComparison.Ordinal);
            if (index < 0) break;
            count++;
            index += value.Length;
        }

        return count;
    }

    public static string NormalizeToLf(string value) =>
        value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\r", "\n", StringComparison.Ordinal);

    public static string TrimLineTrailingWhitespace(string line) =>
        line.TrimEnd(' ', '\t');

    public static string GetLeadingWhitespace(string line)
    {
        var length = 0;
        while (length < line.Length && (line[length] == ' ' || line[length] == '\t'))
            length++;
        return line[..length];
    }

    public static string GetCommonIndent(IReadOnlyList<string> lines)
    {
        string? commonIndent = null;
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var indent = GetLeadingWhitespace(line);
            if (commonIndent is null)
            {
                commonIndent = indent;
                continue;
            }

            var sharedLength = 0;
            var limit = Math.Min(commonIndent.Length, indent.Length);
            while (sharedLength < limit && commonIndent[sharedLength] == indent[sharedLength])
                sharedLength++;
            commonIndent = commonIndent[..sharedLength];
            if (commonIndent.Length == 0) break;
        }

        return commonIndent ?? string.Empty;
    }

    public static string[] StripCommonIndent(IReadOnlyList<string> lines)
    {
        var commonIndent = GetCommonIndent(lines);
        if (string.IsNullOrEmpty(commonIndent))
            return lines.ToArray();

        var result = new string[lines.Count];
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            result[i] = line.StartsWith(commonIndent, StringComparison.Ordinal)
                ? line[commonIndent.Length..]
                : line;
        }

        return result;
    }

    public static string[] ApplyCommonIndent(IReadOnlyList<string> lines, string indent)
    {
        if (string.IsNullOrEmpty(indent))
            return lines.ToArray();

        var result = new string[lines.Count];
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            result[i] = line.Length > 0 ? indent + line : line;
        }

        return result;
    }

    public static IReadOnlyList<(int StartLine, int EndLine, string CommonIndent)> FindNormalizedLineBlockMatches(
        string content,
        string oldString,
        bool indentationMode)
    {
        var contentLines = NormalizeToLf(content).Split('\n');
        var oldLines = NormalizeToLf(oldString).Split('\n');
        if (oldLines.Length == 0 || contentLines.Length < oldLines.Length)
            return Array.Empty<(int StartLine, int EndLine, string CommonIndent)>();

        var normalizedOldLines = (indentationMode ? StripCommonIndent(oldLines) : oldLines.ToArray())
            .Select(TrimLineTrailingWhitespace)
            .ToArray();

        var matches = new List<(int StartLine, int EndLine, string CommonIndent)>();
        for (var startLine = 0; startLine <= contentLines.Length - oldLines.Length; startLine++)
        {
            var slice = contentLines.Skip(startLine).Take(oldLines.Length).ToArray();
            var normalizedSlice = (indentationMode ? StripCommonIndent(slice) : slice)
                .Select(TrimLineTrailingWhitespace)
                .ToArray();
            var isMatch = true;
            for (var i = 0; i < normalizedSlice.Length; i++)
            {
                if (!string.Equals(normalizedSlice[i], normalizedOldLines[i], StringComparison.Ordinal))
                {
                    isMatch = false;
                    break;
                }
            }

            if (isMatch)
            {
                matches.Add((startLine, startLine + oldLines.Length - 1, GetCommonIndent(slice)));
            }
        }

        return matches;
    }

    public static IReadOnlyList<(int StartLine, int EndLine, string CommonIndent)> SelectNonOverlappingLineMatches(
        IReadOnlyList<(int StartLine, int EndLine, string CommonIndent)> matches)
    {
        var selected = new List<(int StartLine, int EndLine, string CommonIndent)>();
        var lastEndLine = -1;
        foreach (var match in matches)
        {
            if (match.StartLine <= lastEndLine) continue;
            selected.Add(match);
            lastEndLine = match.EndLine;
        }

        return selected;
    }

    public static string ApplyNormalizedLineBlockMatches(
        string content,
        string newString,
        IReadOnlyList<(int StartLine, int EndLine, string CommonIndent)> matches,
        bool indentationMode)
    {
        var contentLines = NormalizeToLf(content).Split('\n');
        var newLines = NormalizeToLf(newString).Split('\n');
        var baseReplacementLines = indentationMode ? StripCommonIndent(newLines) : newLines.ToArray();
        var eol = DetectEolStyle(content);
        var result = new List<string>(contentLines.Length + newLines.Length);
        var cursor = 0;

        foreach (var match in matches)
        {
            for (var i = cursor; i < match.StartLine; i++)
                result.Add(contentLines[i]);

            var replacementLines = indentationMode
                ? ApplyCommonIndent(baseReplacementLines, match.CommonIndent)
                : baseReplacementLines;
            result.AddRange(replacementLines);
            cursor = match.EndLine + 1;
        }

        for (var i = cursor; i < contentLines.Length; i++)
            result.Add(contentLines[i]);

        return ApplyEolStyle(string.Join("\n", result), eol);
    }

    public static string DetectEolStyle(string value)
    {
        if (value.Contains("\r\n", StringComparison.Ordinal)) return "\r\n";
        if (value.Contains('\r')) return "\r";
        return "\n";
    }

    public static string ApplyEolStyle(string value, string eol)
    {
        var normalized = value.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\r", "\n", StringComparison.Ordinal);
        return eol == "\n" ? normalized : normalized.Replace("\n", eol, StringComparison.Ordinal);
    }

    // ── Quote normalization (ported from Claude Code) ──

    public static string NormalizeQuotes(string str)
    {
        return str
            .Replace("\u2018", "'", StringComparison.Ordinal)  // left single curly
            .Replace("\u2019", "'", StringComparison.Ordinal)  // right single curly
            .Replace("\u201C", "\"", StringComparison.Ordinal) // left double curly
            .Replace("\u201D", "\"", StringComparison.Ordinal); // right double curly
    }

    /// <summary>
    /// Finds the actual string in file content that matches the search string,
    /// accounting for curly/straight quote normalization.
    /// Returns the actual substring from fileContent, or null if not found.
    /// </summary>
    public static string? FindActualString(string fileContent, string searchString)
    {
        if (fileContent.Contains(searchString, StringComparison.Ordinal))
            return searchString;

        var normalizedSearch = NormalizeQuotes(searchString);
        var normalizedFile = NormalizeQuotes(fileContent);
        var searchIndex = normalizedFile.IndexOf(normalizedSearch, StringComparison.Ordinal);
        if (searchIndex >= 0)
            return fileContent.Substring(searchIndex, searchString.Length);

        return null;
    }

    /// <summary>
    /// When old_string matched via quote normalization, apply the same curly quote
    /// style to new_string so the edit preserves the file's typography.
    /// </summary>
    public static string PreserveQuoteStyle(string oldString, string actualOldString, string newString)
    {
        if (string.Equals(oldString, actualOldString, StringComparison.Ordinal))
            return newString;

        var hasDoubleQuotes = actualOldString.Contains('\u201C') || actualOldString.Contains('\u201D');
        var hasSingleQuotes = actualOldString.Contains('\u2018') || actualOldString.Contains('\u2019');

        if (!hasDoubleQuotes && !hasSingleQuotes)
            return newString;

        var result = newString;
        if (hasDoubleQuotes) result = ApplyCurlyDoubleQuotes(result);
        if (hasSingleQuotes) result = ApplyCurlySingleQuotes(result);
        return result;
    }

    private static bool IsOpeningContext(char[] chars, int index)
    {
        if (index == 0) return true;
        var prev = chars[index - 1];
        return prev is ' ' or '\t' or '\n' or '\r' or '(' or '[' or '{' or '\u2014' or '\u2013';
    }

    private static string ApplyCurlyDoubleQuotes(string str)
    {
        var chars = str.ToCharArray();
        var sb = new StringBuilder(chars.Length);
        for (var i = 0; i < chars.Length; i++)
        {
            if (chars[i] == '"')
                sb.Append(IsOpeningContext(chars, i) ? '\u201C' : '\u201D');
            else
                sb.Append(chars[i]);
        }
        return sb.ToString();
    }

    private static string ApplyCurlySingleQuotes(string str)
    {
        var chars = str.ToCharArray();
        var sb = new StringBuilder(chars.Length);
        for (var i = 0; i < chars.Length; i++)
        {
            if (chars[i] == '\'')
            {
                var prevIsLetter = i > 0 && char.IsLetter(chars[i - 1]);
                var nextIsLetter = i < chars.Length - 1 && char.IsLetter(chars[i + 1]);
                if (prevIsLetter && nextIsLetter)
                    sb.Append('\u2019'); // apostrophe in contraction
                else
                    sb.Append(IsOpeningContext(chars, i) ? '\u2018' : '\u2019');
            }
            else
            {
                sb.Append(chars[i]);
            }
        }
        return sb.ToString();
    }

    // ── Desanitization (handles API-sanitized XML tags) ──

    private static readonly (string From, string To)[] Desanitizations =
    [
        ("<fnr>", "<function_results>"),
        ("<n>", "<name>"),
        ("</n>", "</name>"),
        ("<o>", "<output>"),
        ("</o>", "</output>"),
        ("<e>", "<error>"),
        ("</e>", "</error>"),
        ("<s>", "<system>"),
        ("</s>", "</system>"),
        ("<r>", "<result>"),
        ("</r>", "</result>"),
        ("\n\nH:", "\n\nHuman:"),
        ("\n\nA:", "\n\nAssistant:")
    ];

    public static (string Result, IReadOnlyList<(string From, string To)> AppliedReplacements) DesanitizeMatchString(string matchString)
    {
        var result = matchString;
        var applied = new List<(string From, string To)>();
        foreach (var (from, to) in Desanitizations)
        {
            var before = result;
            result = result.Replace(from, to, StringComparison.Ordinal);
            if (!string.Equals(before, result, StringComparison.Ordinal))
                applied.Add((from, to));
        }
        return (result, applied);
    }

    /// <summary>
    /// Strip trailing whitespace from each line in a string (preserves line endings).
    /// Useful for normalizing new_string before applying edits.
    /// </summary>
    public static string StripTrailingWhitespaceLines(string str)
    {
        var lines = str.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].EndsWith('\r'))
                lines[i] = lines[i].TrimEnd(' ', '\t', '\r') + "\r";
            else
                lines[i] = lines[i].TrimEnd(' ', '\t');
        }
        return string.Join("\n", lines);
    }

    /// <summary>
    /// Detect and strip line number prefixes from Read tool output.
    /// Read output format: "  &lt;lineNo&gt;\t&lt;content&gt;" per line.
    /// Returns stripped string if prefixes detected on all non-empty lines, null otherwise.
    /// </summary>
    public static string? StripLineNumberPrefixes(string str)
    {
        var lines = str.Split('\n');
        if (lines.Length == 0) return null;

        var hasAnyNonEmpty = false;
        foreach (var line in lines)
        {
            if (line.Length == 0) continue;
            hasAnyNonEmpty = true;
            // Check pattern: optional spaces, digits, tab
            var j = 0;
            while (j < line.Length && (line[j] == ' ' || line[j] == '\t')) j++;
            if (j >= line.Length) continue;
            var digitStart = j;
            while (j < line.Length && char.IsDigit(line[j])) j++;
            if (j == digitStart || j >= line.Length || line[j] != '\t')
                return null; // Not a line number prefix
        }

        if (!hasAnyNonEmpty) return null;

        var sb = new StringBuilder();
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0) sb.Append('\n');
            var line = lines[i];
            if (line.Length == 0) continue;
            var tabIndex = line.IndexOf('\t');
            sb.Append(tabIndex >= 0 ? line[(tabIndex + 1)..] : line);
        }
        return sb.ToString();
    }

    /// <summary>
    /// Smart replacement that auto-strips trailing newline when deleting text
    /// (new_string is empty) to avoid leaving blank lines.
    /// </summary>
    public static string ReplaceWithSmartDeletion(
        string content, string oldString, string newString, bool replaceAll)
    {
        if (newString.Length > 0 || oldString.EndsWith('\n'))
            return replaceAll
                ? content.Replace(oldString, newString, StringComparison.Ordinal)
                : ReplaceFirst(content, oldString, newString);

        // Deletion: try to include trailing newline to avoid blank lines
        var withNewline = oldString + "\n";
        if (content.Contains(withNewline, StringComparison.Ordinal))
        {
            var occurrences = CountOccurrences(content, withNewline);
            if (!replaceAll && occurrences > 1)
                throw new InvalidOperationException("old_string is not unique in file");
            return replaceAll
                ? content.Replace(withNewline, "", StringComparison.Ordinal)
                : ReplaceFirst(content, withNewline, "");
        }

        return replaceAll
            ? content.Replace(oldString, newString, StringComparison.Ordinal)
            : ReplaceFirst(content, oldString, newString);
    }


    public static JsonObject BuildReadMetadata(string path, string content, int? offset = null, int? limit = null)
    {
        var normalized = content.Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n');
        var start = Math.Max(0, (offset ?? 1) - 1);
        var maxCount = limit ?? MaxReadLines;
        var count = Math.Max(0, Math.Min(maxCount, MaxReadLines));
        var end = Math.Min(start + count, lines.Length);

        return new JsonObject
        {
            ["path"] = Path.GetFullPath(path),
            ["line_count"] = lines.Length,
            ["offset"] = offset ?? 1,
            ["limit"] = count,
            ["returned_first_line"] = end > start ? start + 1 : null,
            ["returned_last_line"] = end > start ? end : null
        };
    }

    public static async Task WriteFileAsync(string path, string content,
        CancellationToken ct = default)
    {
        var dir = Path.GetDirectoryName(path);
        if (dir is not null && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        await File.WriteAllTextAsync(path, content, ct);
    }

    public static string ReplaceFirst(string content, string oldString, string newString)
    {
        var index = content.IndexOf(oldString, StringComparison.Ordinal);
        if (index < 0)
            throw new InvalidOperationException("old_string not found in file");

        return string.Concat(content.AsSpan(0, index), newString, content.AsSpan(index + oldString.Length));
    }

    public static List<FsEntry> ListDirectory(string path, bool showHidden = false, IEnumerable<string>? ignore = null)
    {
        var dir = new DirectoryInfo(path);
        if (!dir.Exists)
            throw new DirectoryNotFoundException($"Directory not found: {path}");

        var entries = new List<FsEntry>();
        var ignoreMatcher = BuildIgnoreMatcher(ignore);

        foreach (var d in dir.EnumerateDirectories())
        {
            if (!showHidden && d.Name.StartsWith('.')) continue;
            if (ShouldIgnoreDir(d.Name)) continue;
            if (ShouldIgnoreEntry(ignoreMatcher, d.Name, isDirectory: true)) continue;

            entries.Add(new FsEntry
            {
                Name = d.Name,
                Type = "directory",
                Size = null,
                ModifiedAt = new DateTimeOffset(d.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            });
        }

        foreach (var f in dir.EnumerateFiles())
        {
            if (!showHidden && f.Name.StartsWith('.')) continue;
            if (ShouldIgnoreEntry(ignoreMatcher, f.Name, isDirectory: false)) continue;

            entries.Add(new FsEntry
            {
                Name = f.Name,
                Type = "file",
                Size = f.Length,
                ModifiedAt = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            });
        }

        return entries;
    }

    public static void CreateDirectory(string path)
    {
        Directory.CreateDirectory(path);
    }

    public static void Delete(string path)
    {
        if (File.Exists(path))
            File.Delete(path);
        else if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
        else
            throw new FileNotFoundException($"Path not found: {path}");
    }

    public static void Move(string source, string destination)
    {
        if (File.Exists(source))
            File.Move(source, destination, overwrite: true);
        else if (Directory.Exists(source))
            Directory.Move(source, destination);
        else
            throw new FileNotFoundException($"Source not found: {source}");
    }

    private static Matcher? BuildIgnoreMatcher(IEnumerable<string>? ignore)
    {
        if (ignore is null)
            return null;

        var matcher = new Matcher(StringComparison.OrdinalIgnoreCase);
        var hasPatterns = false;
        foreach (var pattern in ignore)
        {
            if (string.IsNullOrWhiteSpace(pattern))
                continue;

            hasPatterns = true;
            matcher.AddInclude(pattern.Replace('\\', '/'));
            matcher.AddInclude($"**/{pattern.Replace('\\', '/')}");
        }

        return hasPatterns ? matcher : null;
    }

    private static bool ShouldIgnoreEntry(Matcher? matcher, string name, bool isDirectory)
    {
        if (matcher is null)
            return false;

        var normalized = name.Replace('\\', '/');
        var candidates = isDirectory
            ? new[] { normalized, $"{normalized}/" }
            : new[] { normalized };

        return candidates.Any(candidate => matcher.Match(candidate).HasMatches);
    }

    private static bool ShouldIgnoreDir(string name) =>
        name is "node_modules" or ".git" or "__pycache__" or ".venv";
}

public class FsEntry
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public long? Size { get; init; }
    public long ModifiedAt { get; init; }
}
