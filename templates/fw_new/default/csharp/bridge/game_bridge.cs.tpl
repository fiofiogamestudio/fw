using Godot;
using __PROJECT_NAME__.Core;
using GdArray = Godot.Collections.Array;
using GdDictionary = Godot.Collections.Dictionary;

namespace __PROJECT_NAME__.Bridge;

public partial class GameBridge : RefCounted
{
    private readonly GameCore _core = new();

    public void Step()
    {
        _core.Step();
    }

    public GdDictionary GetSnapshot()
    {
        var snapshot = new GdDictionary();
        snapshot["tick"] = _core.Tick;
        snapshot["entities"] = new GdArray();
        return snapshot;
    }
}
