using Fw.Rt.Systems;

namespace __PROJECT_NAME__.Core;

internal sealed class CoreRuntime
{
    private readonly SystemRuntime _runtime = new();

    public CoreRuntime(CoreContext context)
    {
        CoreSystems.Setup(_runtime, context);
        _runtime.InitAll();
    }

    public void Tick(float dt)
    {
        _runtime.Tick(dt);
    }

    public void Shutdown()
    {
        _runtime.ShutdownAll();
    }
}
