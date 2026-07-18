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
        new("wire frame rejects malformed headers", TestWireFrameHeaders),
        new("wire frame rejects every single-byte mutation", TestWireFrameMutationSweep),
        new("system phase ordering", TestSystemPhaseOrdering),
        new("system init rollback", TestSystemInitRollback),
        new("system tick fault cleanup", TestSystemTickFaultCleanup),
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

    private static void TestWireFrameHeaders()
    {
        var options = new WireFrameOptions(1024, 1024, 1024);
        byte[] frame = WireFrame.Encode("payload"u8, options);

        Throws(() => WireFrame.Decode(frame.AsSpan(0, 47), options), "magic");
        Throws(() => WireFrame.Decode(Changed(frame, 0, (byte)'X'), options), "magic");
        Throws(() => WireFrame.Decode(Changed(frame, 4, 2), options), "unsupported");
        Throws(() => WireFrame.Decode(Changed(frame, 5, 2), options), "flags");
        Throws(() => WireFrame.Decode(Changed(frame, 6, 1), options), "flags");

        byte[] invalidDecodedLength = [.. frame];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(invalidDecodedLength.AsSpan(8, 4), -1);
        Throws(() => WireFrame.Decode(invalidDecodedLength, options), "decoded length");

        byte[] invalidEncodedLength = [.. frame];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(invalidEncodedLength.AsSpan(12, 4), 1);
        Throws(() => WireFrame.Decode(invalidEncodedLength, options), "encoded length");

        byte[] mismatchedDecodedLength = [.. frame];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(mismatchedDecodedLength.AsSpan(8, 4), 1);
        Throws(() => WireFrame.Decode(mismatchedDecodedLength, options), "decoded length mismatch");
    }

    private static void TestWireFrameMutationSweep()
    {
        byte[] payload = Enumerable.Range(0, 64).Select(value => (byte)value).ToArray();
        var options = new WireFrameOptions(1024, 1024, 1024);
        byte[] frame = WireFrame.Encode(payload, options);

        for (var index = 0; index < frame.Length; index++)
        {
            byte[] changed = [.. frame];
            changed[index] ^= 1;
            int position = index;
            Throws<InvalidDataException>(
                () => WireFrame.Decode(changed, options),
                $"wire frame mutation at byte {position}"
            );
        }
    }

    private static void TestSystemPhaseOrdering()
    {
        var calls = new List<string>();
        var runtime = new SystemRuntime();
        runtime.SetPhaseOrder(["input", "present"]);
        runtime.Add("present", new ProbeSystem(
            () => calls.Add("init:present"),
            () => calls.Add("shutdown:present"),
            _ => calls.Add("tick:present")
        ), new object(), "present");
        runtime.Add("other", new ProbeSystem(
            () => calls.Add("init:other"),
            () => calls.Add("shutdown:other"),
            _ => calls.Add("tick:other")
        ), new object(), "other");
        var inputContext = new object();
        runtime.Add("input", new ProbeSystem(
            () => calls.Add("init:input"),
            () => calls.Add("shutdown:input"),
            _ => calls.Add("tick:input")
        ), inputContext, "input");

        True(runtime.Has("input"), "registered system");
        True(ReferenceEquals(inputContext, runtime.GetContext<object>("input")), "registered context");
        runtime.InitAll();
        runtime.Tick(0.25f);
        runtime.ShutdownAll();

        Equal(
            "init:input,init:present,init:other,tick:input,tick:present,tick:other,shutdown:other,shutdown:present,shutdown:input",
            string.Join(',', calls),
            "phase lifecycle order"
        );
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

    private static void TestSystemTickFaultCleanup()
    {
        var calls = new List<string>();
        var runtime = new SystemRuntime();
        runtime.Add("fault", new ProbeSystem(
            () => calls.Add("init"),
            () => calls.Add("shutdown"),
            _ => throw new InvalidOperationException("tick failed")
        ), new object());

        Throws(() => runtime.Tick(0.1f), "cannot tick");
        runtime.InitAll();
        Throws(() => runtime.Tick(0.1f), "tick failed");
        Equal(SystemRuntimeState.Faulted, runtime.State, "runtime state after tick failure");
        runtime.ShutdownAll();
        Equal(SystemRuntimeState.Stopped, runtime.State, "runtime state after fault cleanup");
        Equal("init,shutdown", string.Join(',', calls), "fault cleanup calls");
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

    private sealed class ProbeSystem(Action init, Action shutdown, Action<float>? tick = null) : ISystem<object>
    {
        public void Init(object context)
        {
            _ = context;
            init();
        }

        public void Tick(float dt)
        {
            tick?.Invoke(dt);
        }

        public void Shutdown()
        {
            shutdown();
        }
    }
}
