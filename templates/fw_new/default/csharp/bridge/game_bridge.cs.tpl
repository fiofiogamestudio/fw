using Godot;
using __PROJECT_NAME__.Core;

namespace __PROJECT_NAME__.Bridge;

public partial class GameBridge : RefCounted
{
    private readonly GameCore _core = new();

    public void Step()
    {
        _core.Step();
    }

    public Dictionary GetSnapshot()
    {
        return new Dictionary
        {
            ["tick"] = _core.Tick,
            ["entities"] = new Array<Dictionary>()
        };
    }
}
