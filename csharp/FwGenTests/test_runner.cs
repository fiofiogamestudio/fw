internal readonly record struct TestCase(string Name, Action Run);

static class TestRunner
{
    internal static int Run()
    {
        TestCase[] tests =
        [
            .. ProtoTests.Cases,
            .. SystemTests.Cases,
            .. BridgeTests.Cases,
            .. ConfigTests.Cases,
            .. RuntimeTests.Cases,
            .. ApiTests.Cases,
        ];

        var failures = new List<string>();
        foreach (var test in tests)
        {
            try
            {
                test.Run();
                Console.WriteLine($"[pass] {test.Name}");
            }
            catch (Exception ex)
            {
                failures.Add($"{test.Name}: {ex.Message}");
                Console.Error.WriteLine($"[fail] {test.Name}: {ex}");
            }
        }

        if (failures.Count > 0)
        {
            Console.Error.WriteLine($"FwGenTests failed: {failures.Count}");
            return 1;
        }

        Console.WriteLine($"FwGenTests passed: {tests.Length}");
        return 0;
    }
}
