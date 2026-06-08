using System.Diagnostics;
using System.Text;
using System.Threading;

static string ResolveProjectRoot()
{
    var cwd = Directory.GetCurrentDirectory();
    var cwdScript = Path.Combine(cwd, "dist", "index.js");
    if (File.Exists(cwdScript))
    {
        return cwd;
    }

    var processPath = Environment.ProcessPath;
    var exeDir = string.IsNullOrWhiteSpace(processPath)
        ? AppContext.BaseDirectory
        : Path.GetDirectoryName(processPath) ?? AppContext.BaseDirectory;

    var direct = Path.Combine(exeDir, "dist", "index.js");
    if (File.Exists(direct))
    {
        return exeDir;
    }

    var parent = Directory.GetParent(exeDir)?.FullName;
    if (!string.IsNullOrWhiteSpace(parent))
    {
        var parentScript = Path.Combine(parent, "dist", "index.js");
        if (File.Exists(parentScript))
        {
            return parent;
        }
    }

    var envHome = Environment.GetEnvironmentVariable("TWC_HOME");
    if (!string.IsNullOrWhiteSpace(envHome))
    {
        var envScript = Path.Combine(envHome, "dist", "index.js");
        if (File.Exists(envScript))
        {
            return envHome;
        }
    }

    throw new InvalidOperationException("Cannot locate dist/index.js. Run twc.exe from the project root or set TWC_HOME to project path.");
}

static int RunNode(string root, IReadOnlyList<string> args)
{
    var scriptPath = Path.Combine(root, "dist", "index.js");

    var psi = new ProcessStartInfo
    {
        FileName = "node",
        WorkingDirectory = root,
        UseShellExecute = false,
    };

    psi.ArgumentList.Add(scriptPath);
    foreach (var arg in args)
    {
        psi.ArgumentList.Add(arg);
    }

    using var process = Process.Start(psi);
    if (process is null)
    {
        Console.Error.WriteLine("Failed to start node process.");
        return 1;
    }

    process.WaitForExit();
    return process.ExitCode;
}

static void PrintShellHeader()
{
    Console.WriteLine("Icon mode active. Type a command and press Enter (the 'twc' prefix is optional).");
    Console.WriteLine("Commands:    products list | jobs list | jobs show <jobId> | doctor");
    Console.WriteLine("Troubleshoot: troubleshoot teamviewer-remote --target ep-001 --issue \"Session drop\"");
    Console.WriteLine("Natural language: tensor cannot reach device vm-twc-demo");
    Console.WriteLine("Type 'help' for assistance, 'cls'/'clear' to clear, 'exit' to close.");
    Console.WriteLine();
}

static void RunClickMode(string root)
{
    DrawAnimatedIntro();
    PrintShellHeader();
    StartTypingAnimation();

    // Ctrl+C must NOT close the window. Intercept it: it cancels the current
    // input line (or the running child command) and returns to the prompt.
    // Exit is only via 'exit'/'quit' or real EOF (Ctrl+Z then Enter).
    //
    // The CancelKeyPress handler runs on a separate thread, so we use a
    // volatile flag and give it a brief moment to flip before deciding whether
    // a null ReadLine was a Ctrl+C (stay) or a genuine Ctrl+Z EOF (exit).
    var cancelFlag = new bool[1];
    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;        // keep the launcher (and its window) alive
        Volatile.Write(ref cancelFlag[0], true);
    };

    while (true)
    {
        Volatile.Write(ref cancelFlag[0], false);
        Console.Write("twc> ");
        var line = Console.ReadLine();

        if (line is null)
        {
            // Could be Ctrl+C (cancel) or Ctrl+Z (real EOF). Let the cancel
            // handler win the race, then decide.
            Thread.Sleep(80);
            if (Volatile.Read(ref cancelFlag[0]))
            {
                Console.WriteLine();
                continue; // Ctrl+C → clear the line, stay in the shell
            }
            break; // genuine EOF (Ctrl+Z)
        }

        var trimmed = line.Trim();
        if (trimmed.Length == 0)
        {
            continue;
        }

        if (trimmed.Equals("exit", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Equals("quit", StringComparison.OrdinalIgnoreCase))
        {
            break;
        }

        if (trimmed.Equals("cls", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Equals("clear", StringComparison.OrdinalIgnoreCase))
        {
            // Clear and redraw the full intro screen (logo, figure, header).
            // The figure animation re-captures the new buffer row inside
            // DrawSeatedFigure, so the running timer keeps targeting it.
            DrawAnimatedIntro();
            PrintShellHeader();
            continue;
        }

        var args = trimmed.Equals("help", StringComparison.OrdinalIgnoreCase)
            ? new List<string> { "--help" }
            : SplitArgs(trimmed);

        // Be forgiving: the banner and examples all show a `twc` prefix, so
        // users naturally type `twc jobs show X` at the `twc>` prompt. Strip a
        // single leading `twc` token so it behaves exactly like `jobs show X`
        // instead of being treated as free-text and triggering a troubleshoot.
        if (args.Count > 0 && args[0].Equals("twc", StringComparison.OrdinalIgnoreCase))
        {
            args.RemoveAt(0);
        }

        if (args.Count == 0)
        {
            continue;
        }

        // Pause the typing animation while a child process owns the console.
        FigureAnim.Busy = true;
        try
        {
            RunNode(root, args);
        }
        finally
        {
            FigureAnim.Busy = false;
        }
        Console.WriteLine();
    }

    StopTypingAnimation();
}

static void DrawAnimatedIntro()
{
    const string reset = "\u001b[0m";
    const string cyan = "\u001b[36m";
    const string blue = "\u001b[34m";
    const string green = "\u001b[32m";
    var useAnsi = !Console.IsOutputRedirected;
    var cReset = useAnsi ? reset : string.Empty;
    var cCyan = useAnsi ? cyan : string.Empty;
    var cBlue = useAnsi ? blue : string.Empty;
    var cGreen = useAnsi ? green : string.Empty;

    Console.Clear();
    Console.WriteLine("$ twc");
    Console.WriteLine();

    var title = "TeamViewer CLI v0.1.0";
    var subtitle = "Describe a task to get started.";
    var tip = "Tip: help shows available commands. exit closes the session.";
    var wordmark = new[]
    {
        "TTTTTT  EEEEEE   AAAAA   M   M  V   V  III  EEEEEE  W     W  III  EEEEEE  RRRR  ",
        "  TT    EE      AA   AA  MM MM  V   V   I   EE      W  W  W   I   EE      RR  RR ",
        "  TT    EEEE    AAAAAAA  M M M  V   V   I   EEEE    W  W  W   I   EEEE    RRRR   ",
        "  TT    EE      AA   AA  M   M   V V    I   EE      W W W W   I   EE      RR RR  ",
        "  TT    EEEEEE  AA   AA  M   M    V    III  EEEEEE   WW WW   III  EEEEEE  RR  RR "
    };

    Console.WriteLine($"{cBlue}+------------------------------------------------------------------+{cReset}");
    Console.WriteLine($"{cBlue}|{cReset} {cCyan}{title.PadRight(64)}{cReset} {cBlue}|{cReset}");
    Console.WriteLine($"{cBlue}|{cReset} {subtitle.PadRight(64)} {cBlue}|{cReset}");
    Console.WriteLine($"{cBlue}+------------------------------------------------------------------+{cReset}");
    Console.WriteLine();

    foreach (var line in wordmark)
    {
        Console.WriteLine($"{cCyan}{line}{cReset}");
        Thread.Sleep(18);
    }

    Console.WriteLine();
    DrawSeatedFigure(useAnsi, cCyan, cReset);
    Console.WriteLine();
    Console.WriteLine($"{cGreen}{tip}{cReset}");
    Console.WriteLine();

    var frames = new[] { "[=     ]", "[==    ]", "[===   ]", "[ ==== ]", "[  ====]", "[   ===]", "[    ==]", "[     =]", "[ READY ]" };
    Console.Write("Loading TeamViewer shell ");

    foreach (var frame in frames)
    {
        Console.Write($"\rLoading TeamViewer shell {cCyan}{frame}{cReset}");
        Thread.Sleep(80);
    }

    Console.WriteLine();
    Console.WriteLine();
}

// Stylized person seated in front of a computer + keyboard. Drawn once at
// intro time. Performs a single intro blink, then the periodic typing
// animation (StartTypingAnimation) repaints the figure in place every 20s.
static void DrawSeatedFigure(bool useAnsi, string cCyan, string cReset)
{
    // Capture the buffer row BEFORE writing the figure so the timer knows
    // where to repaint. Also recaptured on every `cls` (which re-runs the
    // intro), so the animation always targets the current copy.
    int top = Console.CursorTop;

    foreach (var line in FigureAnim.Idle)
    {
        Console.WriteLine($"{cCyan}{line}{cReset}");
    }

    FigureAnim.TopRow = top;
    FigureAnim.LeftCol = 0;
    FigureAnim.UseAnsi = useAnsi;
    FigureAnim.Cyan = cCyan;
    FigureAnim.Reset = cReset;

    if (!useAnsi)
    {
        // No real terminal — skip the intro blink and any later repainting.
        return;
    }

    // One intro blink (preserves the original launcher beat).
    const int eyeIndex = 1;
    string eyesOpen = FigureAnim.Idle[eyeIndex];
    string eyesClosed = eyesOpen.Replace("o o", "- -");
    int up = FigureAnim.Idle.Length - eyeIndex;

    Thread.Sleep(650);
    Console.Write($"\u001b[{up}A\r\u001b[2K{cCyan}{eyesClosed}{cReset}\u001b[{up}B\r");
    Thread.Sleep(150);
    Console.Write($"\u001b[{up}A\r\u001b[2K{cCyan}{eyesOpen}{cReset}\u001b[{up}B\r");
}

// Start a background timer that, every 20 seconds, briefly animates the
// seated figure so it looks like it's typing on its keyboard. The animation
// runs for ~600ms, then the idle pose is restored. The user's prompt cursor
// is saved (ESC[s) and restored (ESC[u) around the repaint.
static void StartTypingAnimation()
{
    if (FigureAnim.Timer != null) return;
    if (!FigureAnim.UseAnsi) return;        // no TTY → no animation
    FigureAnim.Enabled = true;
    FigureAnim.Timer = new System.Threading.Timer(
        _ => RunTypingTick(),
        null,
        TimeSpan.FromSeconds(20),
        TimeSpan.FromSeconds(20));
}

static void StopTypingAnimation()
{
    FigureAnim.Enabled = false;
    FigureAnim.Timer?.Dispose();
    FigureAnim.Timer = null;
}

static void RunTypingTick()
{
    if (!FigureAnim.Enabled || FigureAnim.Busy) return;
    if (FigureAnim.TopRow < 0) return;

    lock (FigureAnim.Lock)
    {
        try
        {
            int top = FigureAnim.TopRow;
            int bot = top + FigureAnim.Idle.Length - 1;
            int winTop = Console.WindowTop;
            int winBot = winTop + Console.WindowHeight - 1;

            // Skip if the figure has scrolled out of the visible window —
            // we never want to repaint somewhere the user can't see.
            if (top < winTop || bot > winBot) return;

            // Save the prompt cursor, animate, restore.
            Console.Write("\u001b[s");
            try
            {
                for (int i = 0; i < 4; i++)
                {
                    if (!FigureAnim.Enabled || FigureAnim.Busy) break;
                    DrawFigureFrame(FigureAnim.Typing[i % FigureAnim.Typing.Length]);
                    Thread.Sleep(150);
                }
                DrawFigureFrame(FigureAnim.Idle);
            }
            finally
            {
                Console.Write("\u001b[u");
            }
        }
        catch
        {
            // Any console resize / position error → just skip this tick.
        }
    }
}

static void DrawFigureFrame(string[] lines)
{
    int top = FigureAnim.TopRow;
    int left = FigureAnim.LeftCol;
    for (int i = 0; i < lines.Length; i++)
    {
        Console.SetCursorPosition(left, top + i);
        Console.Write("\u001b[2K");
        Console.Write(FigureAnim.Cyan);
        Console.Write(lines[i]);
        Console.Write(FigureAnim.Reset);
    }
}

static List<string> SplitArgs(string commandLine)
{
    var args = new List<string>();
    var current = new StringBuilder();
    var inQuotes = false;

    foreach (var ch in commandLine)
    {
        if (ch == '"')
        {
            inQuotes = !inQuotes;
            continue;
        }

        if (char.IsWhiteSpace(ch) && !inQuotes)
        {
            if (current.Length > 0)
            {
                args.Add(current.ToString());
                current.Clear();
            }
            continue;
        }

        current.Append(ch);
    }

    if (current.Length > 0)
    {
        args.Add(current.ToString());
    }

    return args;
}

try
{
    var root = ResolveProjectRoot();
    var incomingArgs = Environment.GetCommandLineArgs().Skip(1).ToArray();

    if (incomingArgs.Length == 0)
    {
        RunClickMode(root);
        Environment.Exit(0);
        return;
    }

    var exitCode = RunNode(root, incomingArgs);
    Environment.Exit(exitCode);
}
catch (Exception ex)
{
    Console.Error.WriteLine($"twc launcher error: {ex.Message}");
    Environment.Exit(1);
}

// Mutable state + ASCII frames for the seated-at-computer figure that types
// every 20s. Kept in a dedicated static class so the timer callback (which
// runs on the threadpool) can reach the same fields the main REPL writes.
static class FigureAnim
{
    // Person at desk + monitor + keyboard. All frames MUST share the same
    // line count and column width so SetCursorPosition + ESC[2K overwrites
    // cleanly without leaving stray characters from the previous frame.
    public static readonly string[] Idle = new[]
    {
        "    .---.        _________  ",
        "   ( o o )      |         | ",
        "    \\   /       |  twc>   | ",
        "   __| |__      |_________| ",
        "     | |       _____________",
        "    /| |\\      [_____________]"
    };

    public static readonly string[][] Typing = new[]
    {
        new[]   // left hand on keys, screen cursor on
        {
            "    .---.        _________  ",
            "   ( o o )      |         | ",
            "    \\   /       |  twc>_  | ",
            "   __| |__      |_________| ",
            "     | |       _____________",
            "   _/| |\\      [_____________]"
        },
        new[]   // right hand on keys, screen cursor off
        {
            "    .---.        _________  ",
            "   ( o o )      |         | ",
            "    \\   /       |  twc>   | ",
            "   __| |__      |_________| ",
            "     | |       _____________",
            "    /| |\\_     [_____________]"
        }
    };

    public static readonly object Lock = new();
    public static int TopRow = -1;
    public static int LeftCol = 0;
    public static bool UseAnsi;
    public static string Cyan = string.Empty;
    public static string Reset = string.Empty;
    public static volatile bool Busy = false;
    public static volatile bool Enabled = false;
    public static System.Threading.Timer? Timer;
}
