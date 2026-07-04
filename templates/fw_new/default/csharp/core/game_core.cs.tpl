using Fw.Rt.Systems;

namespace __PROJECT_NAME__.Core;

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

    public void Step()
    {
        if (_isShutdown)
        {
            return;
        }
        Tick += 1;
        _systems.Tick(1.0f / 30.0f);
    }

    public void Shutdown()
    {
        if (_isShutdown)
        {
            return;
        }
        _systems.ShutdownAll();
        _isShutdown = true;
    }
}
