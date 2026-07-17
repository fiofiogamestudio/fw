using System;
using Fw.Rt.Systems;

namespace __PROJECT_NAMESPACE__.Core;

internal sealed class GameSystem : ISystem<CoreContext>
{
    private CoreContext? _context;

    public void Init(CoreContext context)
    {
        _context = context;
    }

    public void Tick(float dt)
    {
        _ = dt;
        if (_context == null)
        {
            return;
        }

        var increment = 0L;
        foreach (GameIntent intent in _context.State.Intents)
        {
            GameAction? action = intent.Action;
            if (action?.Kind != GameAction.Increment)
            {
                continue;
            }

            IncrementIntent? payload = action.As<IncrementIntent>();
            increment += Math.Clamp(payload?.Amount ?? action.Amount, 1, 1000);
        }

        if (increment == 0)
        {
            return;
        }

        _context.State.Count = (int)Math.Min(int.MaxValue, _context.State.Count + increment);
        _context.State.Events.Add(new CoreEvent
        {
            Type = CoreEvent.CountChanged,
            Payload = new CountChangedEvent { Count = _context.State.Count },
            Count = _context.State.Count,
        });
    }

    public void Shutdown()
    {
        _context = null;
    }
}
