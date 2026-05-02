using Fw.Rt.Systems;

namespace __PROJECT_NAME__.Core;

internal sealed class GameSystem : ISystem<CoreContext>
{
    private CoreContext? _context;

    public void Init(CoreContext context)
    {
        _context = context;
    }

    public void Tick(float dt)
    {
        _ = _context;
        _ = dt;
    }

    public void Shutdown()
    {
        _context = null;
    }
}
