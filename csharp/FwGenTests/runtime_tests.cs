using Fw.Rt.Bridge;
using Fw.Rt.Systems;
using static TestKit;

static class RuntimeTests
{
    internal static TestCase[] Cases =>
    [
        new("generation lock excludes writers", TestGenerationLock),
        new("wire frame round trip", TestWireFrameRoundTrip),
        new("wire frame rejects tampering", TestWireFrameTampering),
        new("system init rollback", TestSystemInitRollback),
        new("system shutdown continues", TestSystemShutdownContinues),
    ];

    private static void TestGenerationLock()
    {
        WithTempDir(root =>
        {
            using var first = GenerationLock.Acquire(root, TimeSpan.FromSeconds(1));
            Throws(() =>
            {
                using var second = GenerationLock.Acquire(root, TimeSpan.FromMilliseconds(25));
            }, "timed out waiting");
        });
    }

    private static void TestWireFrameRoundTrip()
    {
        byte[] value = System.Text.Encoding.UTF8.GetBytes(new string('a', 4096));
        byte[] frame = WireFrame.Encode(value, new WireFrameOptions(64, 8192, 8192));
        True(WireFrame.HasHeader(frame), "wire header");
        True(WireFrame.Decode(frame, new WireFrameOptions(64, 8192, 8192)).SequenceEqual(value), "wire round trip");
    }

    private static void TestWireFrameTampering()
    {
        byte[] frame = WireFrame.Encode("payload"u8);
        frame[^1] ^= 0xff;
        Throws(() => WireFrame.Decode(frame), "checksum mismatch");
        Throws(() => WireFrame.Encode(new byte[32], new WireFrameOptions(0, 16, 64)), "decoded limit");
        Throws(() => WireFrame.Decode(frame, new WireFrameOptions(0, 64, int.MaxValue)), "limits are invalid");
    }

    private static void TestSystemInitRollback()
    {
        var calls = new List<string>();
        var runtime = new SystemRuntime();
        runtime.SetPhaseOrder(["first", "second"]);
        runtime.Add("first", new ProbeSystem(
            () => calls.Add("init:first"),
            () => calls.Add("shutdown:first")
        ), new object(), "first");
        runtime.Add("second", new ProbeSystem(
            () =>
            {
                calls.Add("init:second");
                throw new InvalidOperationException("init failed");
            },
            () => calls.Add("shutdown:second")
        ), new object(), "second");

        Throws(runtime.InitAll, "initialization failed");
        Equal(SystemRuntimeState.Stopped, runtime.State, "runtime state after rollback");
        Equal(
            "init:first,init:second,shutdown:second,shutdown:first",
            string.Join(',', calls),
            "rollback order"
        );
    }

    private static void TestSystemShutdownContinues()
    {
        var calls = new List<string>();
        var runtime = new SystemRuntime();
        runtime.Add("first", new ProbeSystem(
            () => calls.Add("init:first"),
            () => calls.Add("shutdown:first")
        ), new object());
        runtime.Add("second", new ProbeSystem(
            () => calls.Add("init:second"),
            () =>
            {
                calls.Add("shutdown:second");
                throw new InvalidOperationException("shutdown failed");
            }
        ), new object());

        runtime.InitAll();
        Throws(runtime.ShutdownAll, "failed to shut down");
        Equal(SystemRuntimeState.Stopped, runtime.State, "runtime state after shutdown error");
        Equal("init:first,init:second,shutdown:second,shutdown:first", string.Join(',', calls), "shutdown order");
        runtime.ShutdownAll();
    }

    private sealed class ProbeSystem(Action init, Action shutdown) : ISystem<object>
    {
        public void Init(object context)
        {
            _ = context;
            init();
        }

        public void Tick(float dt)
        {
            _ = dt;
        }

        public void Shutdown()
        {
            shutdown();
        }
    }
}
