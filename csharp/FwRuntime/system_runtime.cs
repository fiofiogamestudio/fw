using System.Collections.ObjectModel;

namespace Fw.Rt.Systems;

public interface ISystem<TContext>
    where TContext : class
{
    void Init(TContext context);
    void Tick(float dt);
    void Shutdown();
}

public sealed class SystemRuntime
{
    private readonly List<Entry> _entries = [];
    private readonly Dictionary<string, Entry> _entriesById = new(StringComparer.Ordinal);
    private readonly List<string> _phaseOrder = [];
    private List<Entry>? _orderedEntries;

    public IReadOnlyList<string> PhaseOrder => new ReadOnlyCollection<string>(_phaseOrder);

    public void SetPhaseOrder(IEnumerable<string> order)
    {
        _phaseOrder.Clear();
        foreach (var rawPhase in order)
        {
            var phase = rawPhase.Trim();
            if (phase.Length == 0 || _phaseOrder.Contains(phase, StringComparer.Ordinal))
            {
                continue;
            }
            _phaseOrder.Add(phase);
        }
        _orderedEntries = null;
    }

    public void Add<TContext>(string id, ISystem<TContext> system, TContext context, string phase = "")
        where TContext : class
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("System id cannot be empty.", nameof(id));
        }
        if (_entriesById.ContainsKey(id))
        {
            throw new InvalidOperationException($"Duplicate system id: {id}");
        }

        ArgumentNullException.ThrowIfNull(system);
        ArgumentNullException.ThrowIfNull(context);

        var entry = new Entry(
            id,
            phase,
            context,
            () => system.Init(context),
            system.Tick,
            system.Shutdown
        );
        _entries.Add(entry);
        _entriesById[id] = entry;
        _orderedEntries = null;
    }

    public bool Has(string id)
    {
        return _entriesById.ContainsKey(id);
    }

    public TContext? GetContext<TContext>(string id)
        where TContext : class
    {
        return _entriesById.TryGetValue(id, out var entry)
            ? entry.Context as TContext
            : null;
    }

    public void InitAll()
    {
        foreach (var entry in OrderedEntries())
        {
            entry.Init();
        }
    }

    public void Tick(float dt)
    {
        foreach (var entry in OrderedEntries())
        {
            entry.Tick(dt);
        }
    }

    public void ShutdownAll()
    {
        var ordered = OrderedEntries();
        for (var i = ordered.Count - 1; i >= 0; i--)
        {
            ordered[i].Shutdown();
        }
        _entries.Clear();
        _entriesById.Clear();
        _phaseOrder.Clear();
        _orderedEntries = null;
    }

    private IReadOnlyList<Entry> OrderedEntries()
    {
        if (_orderedEntries != null)
        {
            return _orderedEntries;
        }

        if (_phaseOrder.Count == 0)
        {
            _orderedEntries = [.. _entries];
            return _orderedEntries;
        }

        var ordered = new List<Entry>();
        var added = new HashSet<string>(StringComparer.Ordinal);
        foreach (var phase in _phaseOrder)
        {
            foreach (var entry in _entries)
            {
                if (entry.Phase != phase)
                {
                    continue;
                }
                ordered.Add(entry);
                added.Add(entry.Id);
            }
        }

        foreach (var entry in _entries)
        {
            if (added.Contains(entry.Id))
            {
                continue;
            }
            ordered.Add(entry);
        }
        _orderedEntries = ordered;
        return _orderedEntries;
    }

    private sealed record Entry(
        string Id,
        string Phase,
        object Context,
        Action Init,
        Action<float> Tick,
        Action Shutdown
    );
}
