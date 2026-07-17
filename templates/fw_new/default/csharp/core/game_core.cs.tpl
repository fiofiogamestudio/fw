using System;
using Fw.Rt.Systems;
using System.Collections.Generic;

namespace __PROJECT_NAMESPACE__.Core;

public sealed class GameCore
{
    private readonly CoreContext _context = new();
    private readonly SystemRuntime _systems = new();
    private bool _isShutdown;

    public GameCore()
    {
        CoreSystems.Setup(_systems, _context);
        _systems.InitAll();
    }

    public ulong Tick { get; private set; }
    public int Count => _context.State.Count;
    public IReadOnlyList<CoreEvent> Events => _context.State.Events;

    public void Step(float dt, IReadOnlyList<GameIntent> intents)
    {
        if (_isShutdown)
        {
            throw new ObjectDisposedException(nameof(GameCore));
        }

        Tick += 1;
        _context.State.Events.Clear();
        _context.State.Intents = intents;
        _systems.Tick(Math.Max(dt, 0.0f));
    }

    public void Shutdown()
    {
        if (_isShutdown)
        {
            return;
        }
        try
        {
            _systems.ShutdownAll();
        }
        finally
        {
            _context.State.Intents = [];
            _context.State.Events.Clear();
            _isShutdown = true;
        }
    }
}
