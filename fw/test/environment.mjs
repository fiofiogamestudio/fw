// Fixture-only process configuration; never changes the user's Git configuration.
// Disabling machine fsmonitor prevents persistent daemons in temporary fixtures.
process.env.GIT_CONFIG_COUNT = '2';
process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
process.env.GIT_CONFIG_VALUE_0 = 'false';
process.env.GIT_CONFIG_KEY_1 = 'protocol.file.allow';
process.env.GIT_CONFIG_VALUE_1 = 'always';
